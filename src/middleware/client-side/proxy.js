const cp = require('child_process');

const getSystemProxy = () => {
    let res = {};

    try {
        cp.execSync('scutil --proxy')
            .toString().trim()
            .split('\n')
            .slice(1, -1)
            .forEach((k) => {
                let [key, value] = k.split(' : ');
                res[key.trim()] = value.trim();
            });
    } catch (e) {}

    let {
        HTTPProxy, HTTPPort,
        HTTPSProxy, HTTPSPort,
        SOCKSProxy, SOCKSPort,
        ProxyAutoConfigURLString: pac
    } = res;

    res = {};

    const { env } = process;

    res.http = HTTPProxy ?
        'http://' + HTTPProxy + ':' + HTTPPort :
        env.HTTP_PROXY || env.http_proxy;

    res.https = HTTPSProxy ?
        'https://' + HTTPSProxy + ':' + HTTPSPort :
        env.HTTPS_PROXY || env.https_proxy;

    res.socks = SOCKSProxy ?
        'socks://' + SOCKSProxy + ':' + SOCKSPort :
        env.ALL_PROXY || env.all_proxy;

    if (pac) res.pac = pac;
    
    return res;
}

const clientProxyMiddleware = async (ctx, next) => {
    ctx.request.proxy = getSystemProxy();

    Object.defineProperty(ctx, 'proxy', {
        get: () => ctx.request.proxy,
        set: (proxy) => ctx.request.proxy = proxy
    })
    
    await next();
};

module.exports = clientProxyMiddleware;
