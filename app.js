'use strict';

var request     = require('request'),
    querystring = require('querystring'),
    parseUrl    = require('url').parse,
    logger      = require('log4js'),
    express     = require('express'),
    bodyParser  = require('body-parser'),
    fs          = require('fs'),
    app         = express(),
    server,
    Proxies     = require('./proxymanager'),
    Config      = require('./config'),
    startedAt   = new Date()

logger.configure(Config.logging)
logger = logger.getLogger('proxy-rotator')
logger.setLevel(Config.logLevel || "INFO")

// get config settings
var Port            = Config.port, 
    DefaultTimeout  = Config.defaultTimeout,
    BindAddress     = Config.bindAddress,
    GraceTime       = Config.graceTime || 0,
    NextReqTimeout  = Config.nextRequestTimeout || 2000,
    BlockErrors     = ['ETIMEDOUT', 'ECONNRESET', 'EHOSTUNREACH', 'ESOCKETTIMEDOUT', 'ECONNREFUSED']

app.use(bodyParser.json());

app.get('/status', sendStatus)
app.get('/proxies', sendProxies)
app.post('/admin', admin)
app.get('/', handleRequest)

if(fs.existsSync('.proxies.tmp')) {
  logger.info('restoring previous state')
  fs.readFile('.proxies.tmp', function(err, json) {
    if(err) return logger.error(err)
    var dates = ['blocked', 'broken', 'lastRequest']
    Proxies.setList(JSON.parse(json))
    for(var i = 0; i < Proxies.list.length; i++) {
      var proxy = Proxies.list[i]
      proxy.inUse = false
      for(var key in proxy) {
        if(dates.indexOf(key) !== -1 && proxy[key] !== false) {
          proxy[key] = new Date(proxy[key])
        }
      }
    }
  })
}

setInterval(reportStatus, 10000)

function admin(req, res) {
  if(!req.body) {
    return res.end('no command sent')
  }
  if(req.body.status) {
    return sendStatus(req, res)
  } else if(req.body.proxies) {
    return sendProxies(req, res)
  } else if(req.body.revive) {
    Proxies.list.forEach(function(proxy) {
      proxy.broken = false
      proxy.blocked = false
    })
    res.end('proxies revived')
  } else if(req.body.removeProxy) {
    Proxies.setList(Proxies.list.filter(function(proxy) {
      return proxy.proxy !== req.body.removeProxy
    }))
    res.end('proxy ' + req.body.removeProxy + ' removed')
  } else {
    res.end('unknown command')
  }
}

function reportStatus() {
  var status = Proxies.status()  
  status['wait (s)'] = Proxies.waitTime? Math.round(Proxies.waitTime / 1000): 0
  logger.info(JSON.stringify(status))
}

function sendProxies(req, res) {
  res.end(JSON.stringify(Proxies.list))
}
function sendStatus(req, res) {
  var status = Proxies.status()
  status.startedAt = startedAt
  status['wait (s)'] = Proxies.waitTime? Math.round(Proxies.waitTime / 1000): 0
  status.config = Config
  var firstBlocked = Proxies.firstBlocked()
  if(firstBlocked) {
    firstBlocked = new Date(firstBlocked.blocked.getTime() + (Config.blockTimeout*1000))
    status['next block release'] = firstBlocked.toLocaleString('de')
  }
  res.send(status)
}

/**
 * Handle the incoming request.
 */
function handleRequest (req, res) {
  var query = querystring.parse(req.url.substring(2)), proxy, url
  var timeout = (+query.timeout) || DefaultTimeout

  if(!query.url) {
    return res.end({
      urls: {
        '/status': 'get the service status',
        '/proxies': 'get the proxy status',
        '/?url=[url]': 'send a request for a url'
      }
    })
  }

  url = parseUrl(query.url, true);

  if(!url.host) {
    url = parseUrl('http://' + query.url)
    if(!url.host) return res.send(500).end('supply a proper url, for example: url=google.de')
  }

  if(Proxies.blocked()) {
    return res.status(503).end('all proxies are blocked')
  }

  proxy = Proxies.nextProxy(url.host, function(err, proxy) {
    if(err) {
      if(err === 'ALL_BLOCKED') {
        res.status(503).end('all proxies are blocked')
      } else {
        res.status(503).end('all proxies are broken')
      }
      return
    }

    logger.debug('%s (%s)', query.url, proxy)

    // handle grace time for preventing blocks or/and send the request
    if(GraceTime !== 0 && proxy.lastRequest && Date.now() < proxy.lastRequest.getTime() + GraceTime) {
      var wait = proxy.lastRequest.getTime() + GraceTime - Date.now()
      logger.debug('have to wait for %sms to prevent a block on proxy %s', wait, proxy.proxy)
      Proxies.waitTime+= wait
      setTimeout(function() {
        sendRequest(proxy, url, timeout, req, res)
      }, wait)
    } else {
      sendRequest(proxy, url, timeout, req, res)
    }
  })
}

/**
 * Send the request over the chosen proxy.
 */
function sendRequest(proxy, url, timeout, req, res) {
  var options = {
      url: url,
      proxy: proxy.proxy,
      timeout: timeout
    }

    proxy.inUse = true
    request.get(options, sendResponse(proxy, req, res))
           .on('error', onError(proxy, req, res, url))
}

/**
 * Send the actual response to the client.
 */
function sendResponse(proxy, req, res) {
  return function (err, response, body) {
    proxy.inUse = false
    if(GraceTime !== 0) proxy.lastRequest = new Date()
    if(err) {
      res.writeHead(500, {
        'Content-Length': err.message? err.message.length: 0,
        'Content-Type': 'text/plain',
        'x-proxy': proxy.proxy
      })
      res.status(500).end(err.message || '')
      return
    } else if(response.statusCode === 403) {
      logger.error(proxy.proxy + ' is blocked')
      proxy.blocked = new Date()
      if(Proxies.allBlocked()) {
        logger.error('all proxies are blocked')
      }
      return setTimeout(function() {
        handleRequest(req, res)
      }, NextReqTimeout)
    }
    var header = response.headers
    proxy.hits++
    header['x-proxy'] = proxy.proxy
    res.writeHead(response.statusCode, header)
    res.end(body)
  }
}

/**
 * Called when a error occurs during request, such as timeout, socket exceptions, eg.
 */
function onError(proxy, req, res, url) {
  return function (err) {
    proxy.inUse = false
    // handle timeout as Broken proxy
    if(BlockErrors.indexOf(err.code) !== -1) {
      if(!proxy.broken) {
        proxy.broken = new Date()
        proxy.errors++
        logger.warn('added ' + proxy.proxy + ' to broken list for host ' + url.host + ' (' + err.code + ')')
        if(Proxies.allBroken()) {
          logger.error('all proxies are broken')
        }
      }
    }
    else {
      logger.error(err)
    }
  }
}

/**
 * Log address and port of the running service.
 */
function serverStarted() {
  logger.info('service running at http://%s:%s', 
    server.address().address, server.address().port);
}

function shutdown() {
  logger.info('shutting down')
  server.close()
  fs.writeFile('.proxies.tmp', JSON.stringify(Proxies.list), function () {
    process.exit(0)
  })
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

if(BindAddress) {
  server = app.listen(Port, BindAddress, serverStarted)
} else {
  server = app.listen(Port, serverStarted)
}

