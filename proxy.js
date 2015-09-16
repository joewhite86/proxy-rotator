function Proxy(url) {
  this.proxy = url
  this.broken = false
  this.blocked = false
  this.hits = 0
  this.errors = 0
  this.inUse = false
}

module.exports = Proxy