'use strict';

var http = require('http'),
    request = require('request'),
    fs = require('fs'),
    querystring = require('querystring'),
    parseUrl = require('url').parse

var ConfigFile = 'config.json'

// read the proxy file
var Config = JSON.parse(fs.readFileSync(ConfigFile, 'utf8'))

if(!Config.proxies || Config.proxies.length === 0) throw new Error('there are no proxies in ' + ConfigFile)

// get config settings
var Proxies         = Config.proxies, 
    Port            = Config.port, 
    RepairTime      = Config.repairTime, 
    DefaultTimeout  = Config.defaultTimeout, 
    Broken = {}, 
    Index = {}

/**
 * gets the next proxy from the list
 */
function nextProxy (host) {
  // increment the index value for the host
  if(typeof Index[host] === 'undefined' || Proxies.length === Index[host] + 1) Index[host] = 0
  else Index[host]++

  var proxy = Proxies[Index[host]]

  // check broken hosts
  if(Broken[host]) {
    if(Broken[host].length === Proxies.length) {
      throw new Error('all proxies timed out for ' + host + ', consider using the "timeout" parameter')
    }
    else if(Broken[host][proxy]) {
      // when repair time is over we try the proxy again, so nextProxy isn't called
      if(Date.now() < Broken[host][proxy] + RepairTime) return nextProxy(host)
    }
  }

  return proxy
}

/**
 * Called when a error occurs during request, such as timeout, socket exceptions, eg.
 */
function onError (url, proxy) {
  return function (err) {
    // handle timeout as Broken proxy
    if(err.code === 'ETIMEDOUT') {
      if(!Broken[url.host]) {
        Broken[url.host] = {}
      }
      Broken[url.host][proxy] = Date.now()
      console.log('added ' + proxy + ' to broken list for host ' + url.host)
    }
    else {
      console.log(err)
    }
  }
}

/**
 * Handle the incoming request.
 */
function handleRequest (req, res) {
  var query = querystring.parse(req.url.substring(1)), proxy, url, options

  try {
    if(!query.url) throw new Error('provide a url parameter, for example: service:' + Port + '/url=www.google.de')

    url = parseUrl(query.url, true);

    if(!url.host) {
      url = parseUrl('http://' + query.url)
      if(!url.host) throw new Error('supply a proper url, for example: url=google.de')
    }

    proxy = proxy = nextProxy(url.host)

    options = {
      url: url,
      proxy: proxy,
      timeout: query.timeout || DefaultTimeout
    }

    request.get(options, sendResponse(proxy, res))
           .on('error', onError(url, proxy))
  } catch(e) {
    sendResponse(proxy || 'undefined', res)(e)
  }
}

/**
 * Send the actual response to the client.
 */
function sendResponse (proxy, res) {
  return function (err, response, body) {
    if(err) {
      res.writeHead(500, {
        'Content-Length': err.message? err.message.length: 0,
        'Content-Type': 'text/plain',
        'x-proxy': proxy
      })
      res.end(err.message || '')
    }
    else {
      var header = response.headers
      header['x-proxy'] = proxy
      res.writeHead(response.statusCode, header)
      res.end(body)
    }
  }
}

// create the http server
var server = http.createServer(handleRequest)
// listen to a specific port
server.listen(Port)

console.log('Server running at http://127.0.0.1:' + Port + '/')