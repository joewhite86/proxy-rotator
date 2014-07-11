'use strict';

var http = require('http'),
    request = require('request'),
    fs = require('fs'),
    querystring = require('querystring'),
    parseUrl = require('url').parse, 
    broken = {}, 
    index = {}

// constants
var Port = 8000, ProxyFile = 'proxy.json', RepairTime = 1 * 86400, DefaultTimeout = 5000;

// read the proxy file
var proxys = JSON.parse(fs.readFileSync(ProxyFile, 'utf8'))
if(proxys.length === 0) throw new Error('there are no proxies in ' + ProxyFile)

/**
 * gets the next proxy from the list
 */
function nextProxy (host) {
  // increment the index value for the host
  if(typeof index[host] === 'undefined' || proxys.length === index[host] + 1) index[host] = 0
  else index[host]++

  var proxy = proxys[index[host]]

  // check broken hosts
  if(broken[host]) {
    if(broken[host].length === proxys.length) {
      throw new Error('all proxies timed out for ' + host + ', consider using the "timeout" parameter')
    }
    else if(broken[host][proxy]) {
      // when repair time is over we try the proxy again, so nextProxy isn't called
      if(Date.now() < broken[host][proxy] + RepairTime) return nextProxy(host)
    }
  }

  return proxy
}

/**
 * Called when a error occurs during request, such as timeout, socket exceptions, eg.
 */
function onError (url, proxy) {
  return function (err) {
    // handle timeout as broken proxy
    if(err.code === 'ETIMEDOUT') {
      if(!broken[url.host]) {
        broken[url.host] = {}
      }
      broken[url.host][proxy] = Date.now()
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
  var query = querystring.parse(req.url.substring(1))

  try {
    if(!query.url) throw new Error('provide a url parameter, for example: service:' + Port + '/url=www.google.de')

    var url = parseUrl(query.url, true);

    if(!url.host) {
      url = parseUrl('http://' + query.url)
      if(!url.host) throw new Error('supply a proper url, for example: url=google.de')
    }

    var proxy = proxy = nextProxy(url.host)

    var options = {
      url: url,
      proxy: proxy,
      timeout: query.timeout || DefaultTimeout
    }

    request.get(options, sendResponse(res))
           .on('error', onError(url, proxy))
  } catch(e) {
    sendResponse(res)(e)
  }
}

/**
 * Send the actual response to the client.
 */
function sendResponse (res) {
  return function (err, response, body) {
    if(err) {
      res.writeHead(500, {
        'Content-Length': err.message? err.message.length: 0,
        'Content-Type': 'text/plain'
      })
      res.end(err.message || '');
    }
    else {
      res.writeHead(response.statusCode, response.headers)
      res.end(body);
    }
  }
}

// create the http server
var server = http.createServer(handleRequest)
// listen to a specific port
server.listen(Port)

console.log('Server running at http://127.0.0.1:' + Port + '/')