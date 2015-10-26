var Index               = {}, 
    Config              = require('./config'),
    Proxy               = require('./proxy'),
    shuffle             = require('knuth-shuffle').knuthShuffle,
    logger              = require('log4js'),
    list                = shuffle(Config.proxies.map(function(p) { return new Proxy(p) })),
    MaxErrors           = Config.maxErrors || 3,
    RepairTime          = Config.repairTime*1000, 
    BlockTimeout        = Config.blockTimeout*1000,
    AllowMultipleCalls  = Config.allowMultipleCalls || false,
    UseWaitTime         = Config.useWaitTime || 200,
    FreeSlotsNeeded     = Config.freeSlotsNeeded || 30

logger.configure(Config.logging)
logger = logger.getLogger('proxy-rotator')
logger.setLevel(Config.logLevel || "INFO")

var ProxyManager = {}

ProxyManager.isActive = function(proxy, now) {
  if(typeof now === 'undefined') now = Date.now()
  return (proxy.errors < MaxErrors || proxy.hits !== 0) &&
    (!proxy.blocked || now >= proxy.blocked.getTime() + BlockTimeout) &&
    (!proxy.broken || now >= proxy.broken.getTime() + RepairTime)
}
ProxyManager.status = function() {
  var now = Date.now()
  var status = {
    proxies: list.length,
    alive: 0,
    error: 0,
    broken: 0,
    blocked: 0,
    inUse: 0
  }
  list.forEach(function(proxy) { 
    if(proxy.errors >= MaxErrors && proxy.hits === 0) {status.error++;status.broken++}
    else if(proxy.broken && now < proxy.broken.getTime() + RepairTime) status.broken++
    else if(proxy.blocked && now < proxy.blocked.getTime() + BlockTimeout) {status.blocked++;status.broken++}
    else if(proxy.inUse) {status.inUse++; status.alive++}
    else status.alive++
  })
  return status
}
ProxyManager.firstBlocked = function() {
  var proxy
  list.forEach(function(p) {
    if(p.blocked && (!proxy || proxy.blocked > p.blocked))
      proxy = p
  })
  return proxy
}
ProxyManager.allBlocked = function() {
  var now = Date.now()
  return !list.some(function(proxy) {
    return (proxy.errors < MaxErrors || proxy.hits !== 0) &&
      (!proxy.blocked || now >= proxy.blocked.getTime() + BlockTimeout);
  })
}
ProxyManager.allBroken = function() {
  var now = Date.now(), that = this
  return list.every(function(proxy) { 
    return !that.isActive(proxy, now)
  })
}
ProxyManager.allInUse = function() {
  var now = Date.now(), that = this
  return list.every(function(proxy) { 
    return proxy.inUse || !that.isActive(proxy, now)
  })
}
ProxyManager.blocked = function() {
  if(this._allBlocked) {
    var count = 0, now = Date.now(), that = this
    list.some(function(proxy) {
      if(that.isActive(proxy, now)) {
        if(++count === FreeSlotsNeeded) return true
      }
      return false
    })
    if(count === FreeSlotsNeeded) {
      this._allBlocked = false
    } else {
      return true
    }
  }
  return false
}
ProxyManager.setList = function(newList) {
  list = newList
  this.list = list
}

/**
 * gets the next proxy from the list
 */
ProxyManager.nextProxy = function(host, cb) {
  if(this.allBroken()) {
    if(this.allBlocked()) {
      this._allBlocked = true
      return cb('ALL_BLOCKED')
    }
    return cb('ALL_BROKEN')
  }
  // increment the index value for the host
  if(typeof Index[host] === 'undefined' || list.length === Index[host] + 1) {
    if(typeof Index[host] === 'undefined') {
      logger.debug('all proxies used, starting new cycle')
    }
    Index[host] = 0
  } else {
    Index[host]++
  }
  var proxy = list[Index[host]]

  if(proxy.errors >= MaxErrors && proxy.hits === 0) {
    // if a proxy 
    return this.nextProxy(host, cb)
  } else if(!AllowMultipleCalls && proxy.inUse) {
    // once we hit a proxy in use, we check if any other is free at the moment, 
    // if not, we sleep for a small amount of time
    if(!AllowMultipleCalls && this.allInUse()) {
      var that = this
      this.timeWaited+= UseWaitTime
      return setTimeout(function() {that.nextProxy(host, cb)}, UseWaitTime)
    }
    return this.nextProxy(host, cb)
  } else if(proxy.blocked) {
    // check if the block has timed out
    if(Date.now() < proxy.blocked.getTime() + BlockTimeout) {
      return this.nextProxy(host, cb)
    } else {
      logger.info('reviving blocked proxy ' + proxy.proxy + ' after ' + BlockTimeout + 'ms')  
      proxy.blocked = false
    }
  } else if(proxy.broken) {
    // check if the repair time is over
    if(Date.now() < proxy.broken.getTime() + RepairTime) {
      return this.nextProxy(host, cb)
    } else {
      logger.info('reviving broken proxy ' + proxy.proxy + ' after ' + RepairTime + 'ms')
      proxy.broken = false
    }
  }

  return cb(null, proxy)
}

ProxyManager.list = list

module.exports = ProxyManager