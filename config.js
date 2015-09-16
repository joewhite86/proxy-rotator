var fs = require('fs'),
    ConfigFile = 'config.json'

// read the proxy file
var Config = JSON.parse(fs.readFileSync(ConfigFile, 'utf8'))

if(!Config.proxies || Config.proxies.length === 0) throw new Error('there are no proxies in ' + ConfigFile)

module.exports = Config