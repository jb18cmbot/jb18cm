// ==UserScript==
// @name         GMGN WSS 监控 + 快捷买入5.3
// @namespace    http://tampermonkey.net/
// @version      5.3
// @description  拦截 GMGN 原生 WebSocket + 规则匹配 + 一键快捷买入（支持多推特账号管理）
// @author       Grok & Claude
// @match        https://gmgn.ai/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @require      https://cdn.jsdelivr.net/npm/ethers@6.7.0/dist/ethers.umd.min.js
// ==/UserScript==

(function () {
    'use strict';

    // ==================== 配置 ====================
    const WSS_URL = null; // 不再使用外部 WSS，改用拦截 GMGN 自身的 WebSocket
    const API_URL = 'https://jbot.live/jk_config.php';
    const SECRET_TOKEN = 'gmgn';

    const TRADE_CONFIG = {
        TRADE_WS: 'wss://sms.lvrpc.space/ws',
        INNER_GAS: 1,         // 内盘 Gas (Gwei)，换算: bid = Gas / 200
        BID: '0.0004',        // 外盘 BID (BNB)
        SLIPPAGE: 50,         // 默认滑点 50%
        QUICK_AMOUNTS: [0.1, 0.3, 0.5, 1.0],
        USD1_ADDRESS: '0x8d0D000Ee44948FC98c9B98A4FA4921476f08B0d'  // USD1 代币地址
    };

    // Gas 换算为 BID (string 类型)
    function gasToBid(gas) {
        return String(gas / 200);
    }

    const RECONNECT_INTERVAL = 5000;
    const MAX_RECONNECT_ATTEMPTS = 30;
    const MAX_HISTORY = 50;

    let socket = null;
    let reconnectAttempts = 0;
    let isManuallyClosed = false;
    let messageHistory = [];
    let displayedTweetKeys = new Set();
    let matchRules = [];

    // ==================== WebSocket 拦截器 ====================
    // 将拦截器代码注入到页面上下文中
    const interceptorScript = document.createElement('script');
    interceptorScript.textContent = `
        (function() {
            console.log('[GMGN拦截器] 初始化 WebSocket 拦截...');

            // 保存原始 WebSocket
            const OriginalWebSocket = window.WebSocket;

            // 重写 WebSocket 构造函数
            window.WebSocket = function(url, protocols) {
                console.log('[WS] 检测到连接:', url);

                // 只拦截 GMGN 的 WebSocket
                if (url.includes('gmgn.ai/ws') || url.includes('ws.gmgn.ai')) {
                    console.log('[GMGN] ✓ 已拦截目标连接');

                    const ws = new OriginalWebSocket(url, protocols);

                    // 保存原始的 addEventListener
                    const originalAddEventListener = ws.addEventListener.bind(ws);

                    // 重写 addEventListener
                    ws.addEventListener = function(type, listener, options) {
                        if (type === 'message') {
                            const wrappedListener = function(event) {
                                try {
                                    const data = JSON.parse(event.data);

                                    const isTwitterChannel = (data.channel === 'twitter_user_monitor_basic' ||
                                                             data.channel === 'twitter_monitor_express') &&
                                                             data.data;

                                    if (isTwitterChannel) {
                                        const channelName = data.channel === 'twitter_monitor_express' ? 'Express' : 'Basic';
                                        console.log(\`[GMGN拦截] 收到 \${channelName} 频道消息，共 \${data.data.length} 条\`);

                                        // 触发自定义事件，传递数据给用户脚本
                                        window.dispatchEvent(new CustomEvent('gmgn-tweet-message', {
                                            detail: { data: data.data, channel: channelName }
                                        }));
                                    }
                                } catch (e) {
                                    // 非 JSON 消息,忽略
                                }

                                return listener.call(this, event);
                            };

                            return originalAddEventListener(type, wrappedListener, options);
                        }
                        return originalAddEventListener(type, listener, options);
                    };

                    // 重写 onmessage setter
                    let onmessageHandler = null;
                    Object.defineProperty(ws, 'onmessage', {
                        get() {
                            return onmessageHandler;
                        },
                        set(handler) {
                            onmessageHandler = handler;

                            originalAddEventListener('message', function(event) {
                                try {
                                    const data = JSON.parse(event.data);

                                    const isTwitterChannel = (data.channel === 'twitter_user_monitor_basic' ||
                                                             data.channel === 'twitter_monitor_express') &&
                                                             data.data;

                                    if (isTwitterChannel) {
                                        const channelName = data.channel === 'twitter_monitor_express' ? 'Express' : 'Basic';
                                        console.log(\`[GMGN拦截] 收到 \${channelName} 频道消息，共 \${data.data.length} 条\`);

                                        // 触发自定义事件，传递数据给用户脚本
                                        window.dispatchEvent(new CustomEvent('gmgn-tweet-message', {
                                            detail: { data: data.data, channel: channelName }
                                        }));
                                    }
                                } catch (e) {
                                    // 非 JSON 消息,忽略
                                }

                                if (handler) {
                                    handler.call(this, event);
                                }
                            });
                        }
                    });

                    return ws;
                }

                // 非目标 URL,直接返回原始 WebSocket
                return new OriginalWebSocket(url, protocols);
            };

            // 复制静态属性
            window.WebSocket.CONNECTING = OriginalWebSocket.CONNECTING;
            window.WebSocket.OPEN = OriginalWebSocket.OPEN;
            window.WebSocket.CLOSING = OriginalWebSocket.CLOSING;
            window.WebSocket.CLOSED = OriginalWebSocket.CLOSED;

            console.log('[GMGN拦截器] WebSocket 拦截器已就绪');
        })();
    `;

    // 在 document-start 阶段注入
    (document.head || document.documentElement).appendChild(interceptorScript);
    interceptorScript.remove(); // 注入后移除 script 标签

    console.log('[GMGN拦截器] 拦截器脚本已注入');

    // 用于去重的缓存
    const tweetCache = new Map();
    const CACHE_EXPIRE_TIME = 60000; // 60秒后过期

    // 监听来自页面的自定义事件
    window.addEventListener('gmgn-tweet-message', function(event) {
        const { data, channel } = event.detail;
        console.log(`[用户脚本] 收到 ${channel} 频道消息，共 ${data.length} 条`);

        data.forEach((item) => {
            processGMGNTweet(item, channel);
        });
    });

    // 处理 GMGN 推文消息
    function processGMGNTweet(item, channelName) {
        const tweetId = item.ti;
        const contentLength = JSON.stringify(item).length;
        const now = Date.now();

        // 检查缓存去重
        const cached = tweetCache.get(tweetId);

        if (cached) {
            // 如果缓存已过期，清除
            if (now - cached.timestamp > CACHE_EXPIRE_TIME) {
                tweetCache.delete(tweetId);
            } else {
                // 发现重复
                console.log(`%c[去重] 检测到重复推文 ID: ${tweetId}`, 'color: #ff6600; font-style: italic;');
                console.log(`  当前消息长度: ${contentLength}, 缓存消息长度: ${cached.length}, 频道: ${channelName}`);

                // 如果当前消息更长，更新缓存
                if (contentLength > cached.length) {
                    console.log(`  %c✓ 当前消息更完整，更新显示`, 'color: #00ff00;');
                    tweetCache.set(tweetId, {
                        length: contentLength,
                        timestamp: now
                    });
                } else {
                    console.log(`  %c✗ 缓存消息更完整，跳过当前消息\n`, 'color: #888;');
                    return; // 跳过这条消息
                }
            }
        } else {
            // 首次出现，加入缓存
            tweetCache.set(tweetId, {
                length: contentLength,
                timestamp: now
            });
        }

        // 转换为统一格式并添加到消息历史
        const msgType = item.tw === 'retweet' ? 'update_tweet' : 'new_tweet';
        const time = new Date(parseInt(item.ts)).toLocaleTimeString([], { hour12: false });
        const name = item.u.n || item.u.s || '未知';
        const author = item.u.s || '未知';
        const avatarUrl = ''; // GMGN 数据中没有头像 URL
        const text = (item.c?.t || '').trim();
        const currentUrl = `https://twitter.com/${author}/status/${tweetId}`;

        let originalText = '';
        let originalUrl = '';
        let originalAuthor = '';
        let isOriginal = false;

        // 检查是否有来源推文（转发/引用）
        if (item.su && item.si) {
            isOriginal = true;
            originalText = (item.sc?.t || '').trim();
            originalAuthor = item.su.s || '未知';
            originalUrl = `https://twitter.com/${originalAuthor}/status/${item.si}`;
        }

        console.log(`\n%c=== GMGN Twitter 消息 [${channelName}] ===`, 'color: #00ff00; font-weight: bold; font-size: 14px;');
        console.log('推文链接:', currentUrl);
        console.log('用户:', name, `(@${author})`);
        console.log('内容:', text);
        if (isOriginal) {
            console.log('来源推文:', originalUrl);
            console.log('来源内容:', originalText);
        }
        console.log('%c========================\n', 'color: #00ff00; font-weight: bold;');

        // 添加到消息历史
        addMessageToHistory(msgType, time, name, author, avatarUrl, text, currentUrl, originalUrl, originalText, isOriginal, tweetId, originalAuthor);
    }

    // ==================== 交易核心模块 ====================
    class TradeWS {
        constructor() { this.ws = null; this.ready = false; this.requests = {}; this.pingTimer = null; this.requestCounter = 0; }
        async connect() {
            if (this.ws?.readyState === WebSocket.OPEN) return;
            if (this.ws?.readyState === WebSocket.CONNECTING) { while (!this.ready) await new Promise(r => setTimeout(r, 50)); return; }
            return new Promise(resolve => {
                this.ws = new WebSocket(TRADE_CONFIG.TRADE_WS);
                this.ws.onopen = () => { this.ready = true; console.log('[交易WS] 已连接'); this.pingTimer = setInterval(() => this.ws?.readyState === WebSocket.OPEN && this.ws.send(JSON.stringify({ type: "ping" })), 30000); resolve(); };
                this.ws.onclose = () => { this.ready = false; clearInterval(this.pingTimer); setTimeout(() => this.connect(), 3000); };
                this.ws.onerror = () => this.ws.close();
                this.ws.onmessage = e => { try { const m = JSON.parse(e.data); if (m.id && this.requests[m.id]) { console.log(`[TradeWS] 收到响应 id=${m.id}`, m.status || ''); this.requests[m.id].resolve(m.result || m); delete this.requests[m.id]; } } catch (err) {} };
            });
        }
        async send(payload, timeout = 10000) {
            await this.connect();
            // 使用时间戳 + 计数器 + 随机数确保唯一 ID
            const id = Date.now() * 1000 + (++this.requestCounter % 1000) + Math.floor(Math.random() * 100);
            payload.id = id;
            console.log(`[TradeWS] 发送请求 id=${id} api=${payload.api}`, payload.token ? `token=${payload.token}` : '');
            return new Promise((resolve, reject) => {
                this.requests[id] = { resolve, reject };
                this.ws.send(JSON.stringify(payload));
                setTimeout(() => { if (this.requests[id]) { console.log(`[TradeWS] 请求超时 id=${id}`); reject(new Error("超时")); delete this.requests[id]; } }, timeout);
            });
        }
    }

    const tradeWS = new TradeWS();

    // parseToken 缓存：同一 CA 5秒内不重复请求
    const _parseTokenCache = new Map();
    const PARSE_CACHE_TTL = 5000;

    async function parseToken(tokenAddress) {
        const key = tokenAddress.toLowerCase();
        const cached = _parseTokenCache.get(key);
        if (cached && Date.now() - cached.ts < PARSE_CACHE_TTL) return cached.data;

        // 用 GMGN search API 判断内外盘 + USD1/BNB（同源请求，无需跨域）
        const res = await fetch(`/vas/api/v1/search_v2?chain=bsc&q=${key}`);
        const json = await res.json();
        const coin = json.data?.coins?.find(c => c.address?.toLowerCase() === key);
        if (!coin) throw new Error('Token not found on GMGN');

        const quoteAddress = coin.quote_address || coin.launch_quote_address || '';
        const isUSD1Pool = quoteAddress.toLowerCase() === TRADE_CONFIG.USD1_ADDRESS.toLowerCase();
        const isInternal = coin.launchpad_status === 0;
        const data = {
            progress: coin.progress || 0,
            isInternal,
            quoteAddress,
            isUSD1Pool
        };
        _parseTokenCache.set(key, { data, ts: Date.now() });
        return data;
    }

    async function quickBuy(tokenAddress, bnbAmount, nonceOffset = 0) {
        const buyStartTime = Date.now();
        console.log(`[quickBuy] 开始买入 ${tokenAddress} | ${bnbAmount} BNB | nonceOffset: ${nonceOffset}`);

        const settings = getTradeSettings();
        const wallets = JSON.parse(localStorage.getItem('wss-wallets') || '[]');
        const selectedNames = JSON.parse(localStorage.getItem('wss-selected-wallets') || '[]');
        const selectedWallets = wallets.filter(w => selectedNames.includes(w.name));

        if (selectedWallets.length === 0) {
            console.error('[quickBuy] 错误: 没有选择钱包');
            showTradeStatus('❌ 请先选择钱包', 'error');
            return;
        }

        const walletCount = selectedWallets.length;
        const perWalletAmount = bnbAmount / walletCount;
        console.log(`[quickBuy] 使用 ${walletCount} 个钱包，每个 ${perWalletAmount} BNB`);
        showTradeStatus(`⏳ ${walletCount}个钱包买入 ${bnbAmount} BNB...`, 'loading');

        try {
            console.log(`[quickBuy] 解析代币信息...`);
            const parseStart = Date.now();
            const parsed = await parseToken(tokenAddress);
            const poolType = parsed.isInternal
                ? (parsed.isUSD1Pool ? 'USD1内盘' : 'BNB内盘')
                : '外盘';
            console.log(`[quickBuy] 解析完成 (${Date.now() - parseStart}ms) | ${poolType} | 进度: ${(parsed.progress * 100).toFixed(2)}%`);

            // 统一使用 WSS API 买入（内外盘都用 api: 'buy'）
            // 计算 bid：内盘用 Gas 换算，外盘直接用 BID
            const bid = parsed.isInternal
                ? gasToBid(settings.innerGas || TRADE_CONFIG.INNER_GAS)
                : String(settings.bid || TRADE_CONFIG.BID);

            // 确定 innerToken
            const innerToken = parsed.isInternal
                ? (parsed.isUSD1Pool ? 'USD1' : 'BNB')
                : 'BNB';

            console.log(`[quickBuy] ${poolType}买入模式 | innerToken: ${innerToken} | bid: ${bid} | slippage: ${settings.slippage || TRADE_CONFIG.SLIPPAGE}%`);

            // 构建 pack 数组（每个钱包一个）
            const pack = selectedWallets.map(w => {
                const pk = w.pk.startsWith('0x') ? w.pk.slice(2) : w.pk;
                const reversepk = pk.split("").reverse().join("");
                return {
                    reversepk,
                    amountIn: perWalletAmount.toString(),
                    slippage: settings.slippage || TRADE_CONFIG.SLIPPAGE,
                    bid
                };
            });

            const payload = {
                api: 'buy',
                outerToken: tokenAddress,
                innerToken,
                pack
            };

            console.log(`[quickBuy] 组装买入请求:`, {
                api: payload.api,
                outerToken: tokenAddress,
                innerToken,
                packCount: pack.length,
                amountIn: perWalletAmount,
                bid,
                slippage: settings.slippage || TRADE_CONFIG.SLIPPAGE
            });

            console.log(`[quickBuy] 发送买入交易...`);
            const sendStart = Date.now();
            const result = await tradeWS.send(payload);
            console.log(`[quickBuy] 买入交易完成 (${Date.now() - sendStart}ms)`, result);
            showTradeStatus(`✅ ${poolType}买入成功 (${walletCount}钱包)`, 'success');
            console.log(`[quickBuy] 总耗时: ${Date.now() - buyStartTime}ms`);
            return result;
        } catch (e) {
            console.error(`[quickBuy] 买入失败 (${Date.now() - buyStartTime}ms):`, e);
            showTradeStatus(`❌ ${e.message}`, 'error');
            throw e;
        }
    }

    // ==================== 节点缓存 ====================
    const FULL_CACHE_KEY = 'ambush_all_nodes_cache';
    const NODE_INDEX_KEY = 'ambush_node_index';
    const POLL_INTERVAL = 30000;
    let pollingTimer = null;
    // 内存缓存：避免 renderMessage 每次都读 GM_getValue（数据只有 fetchFullData 30秒更新一次）
    let _memFullData = null;
    let _memNodeIndex = null;

    function buildNodeIndexFromCache() {
        const cached = _memFullData || GM_getValue(FULL_CACHE_KEY, null);
        if (!cached || !cached.nodes) return;
        const index = Object.create(null);
        Object.values(cached.nodes).forEach(node => {
            const coin = node.ca; if (!coin || typeof coin !== 'string') return;
            const keywords = [];
            if (node.ticket && typeof node.ticket === 'string') keywords.push(node.ticket);
            if (node.symbol && typeof node.symbol === 'string' && node.symbol.length >= 3) keywords.push(node.symbol);
            if (node.ca && typeof node.ca === 'string' && node.ca.length >= 10) keywords.push(node.ca);
            keywords.forEach(k => { const key = k.toLowerCase(); if (!index[key]) index[key] = []; if (!index[key].includes(coin)) index[key].push(coin); });
        });
        GM_setValue(NODE_INDEX_KEY, index);
        _memNodeIndex = index;
    }

    function fetchFullData() {
        GM_xmlhttpRequest({
            method: 'GET', url: 'https://jbot.live/a7/api.php?action=get_all_data',
            onload: res => { try { const data = JSON.parse(res.responseText); if (data.ok && data.nodes) { const fullData = { nodes: data.nodes, folders: data.folders || {}, timestamp: Date.now() }; GM_setValue(FULL_CACHE_KEY, fullData); _memFullData = fullData; buildNodeIndexFromCache(); } } catch (e) {} },
            onerror: () => {}
        });
    }

    function getRelatedNodesLocally(targetCa, ruleName = '') {
        const cached = _memFullData || GM_getValue(FULL_CACHE_KEY, null);
        if (!cached || !cached.nodes) return { ok: 1, nodes: [] };
        const nodes = cached.nodes, leaderIds = {}, resultNodes = [], seen = {};
        for (const id in nodes) { const node = nodes[id]; if ((node.ca || '') !== targetCa) continue; const level = node.level || 'leader'; if (level === 'leader') leaderIds[id] = true; else if (node.parent && nodes[node.parent]) leaderIds[node.parent] = true; }
        for (const leaderId in leaderIds) { const leader = nodes[leaderId]; if (leader) { const key = leader.ca || leaderId; if (!seen[key]) { seen[key] = true; resultNodes.push(leader); } } for (const nid in nodes) { const n = nodes[nid]; if ((n.parent || '') === leaderId) { const key = n.ca || nid; if (!seen[key]) { seen[key] = true; resultNodes.push(n); } } } }
        if (resultNodes.length === 0) resultNodes.push({ ca: targetCa, ticket: ruleName, level: 'virtual', is_empty: 1 });
        return { ok: 1, count: resultNodes.length, nodes: resultNodes };
    }

    function startFullSync() {
        if (pollingTimer) clearInterval(pollingTimer);
        if (!_memFullData) _memFullData = GM_getValue(FULL_CACHE_KEY, null);
        if (!_memNodeIndex) _memNodeIndex = GM_getValue(NODE_INDEX_KEY, null);
        fetchFullData();
        pollingTimer = setInterval(fetchFullData, POLL_INTERVAL);
    }

    // ==================== 规则同步 ====================
    async function loadRulesFromServer() { try { const res = await fetch(API_URL); const data = await res.json(); if (data.success) matchRules = data.rules || []; } catch (e) {} }
    async function addRuleToServer(rule) { try { const res = await fetch(API_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...rule, token: SECRET_TOKEN }) }); const data = await res.json(); if (data.success) matchRules = data.rules || []; } catch (e) {} }
    async function removeRuleFromServer(index) { try { const res = await fetch(API_URL, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ index, token: SECRET_TOKEN }) }); const data = await res.json(); if (data.success) matchRules = data.rules || []; } catch (e) {} }

    // ==================== UI: 唤出按钮 ====================
    let wakeBtn = null;
    let floatBox = null;
    let historyContent = null;

    function createWakeButton() {
        // 移除旧的按钮（如果存在）
        const oldBtn = document.getElementById('wss-wake-btn');
        if (oldBtn) oldBtn.remove();

        const btn = document.createElement('div');
        btn.id = 'wss-wake-btn';
        Object.assign(btn.style, { position: 'fixed', bottom: '30px', right: '30px', width: '50px', height: '50px', borderRadius: '50%', background: 'linear-gradient(135deg, #1d9bf0, #0f0)', color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 'bold', fontSize: '14px', cursor: 'pointer', zIndex: '999999', boxShadow: '0 4px 12px rgba(29,155,240,0.5)' });
        btn.textContent = 'WSS';
        btn.onclick = () => { floatBox.style.display = 'flex'; btn.style.display = 'none'; };
        document.body.appendChild(btn);
        wakeBtn = btn;
        return btn;
    }

    // ==================== 自动买入（服务器同步版） ====================
    const AUTOBUY_API = API_URL + '?type=autobuy';  // 使用同一个 API，加 type=autobuy
    let autoBuyRules = [];  // 缓存规则

    async function loadAutoBuyRulesFromServer() {
        try {
            const res = await fetch(AUTOBUY_API);
            const data = await res.json();
            if (data.success) {
                autoBuyRules = data.rules || [];
                console.log('[自动买入] 从服务器加载:', autoBuyRules.length, '条规则');
            }
        } catch (e) {
            console.error('[自动买入] 加载失败:', e);
        }
        return autoBuyRules;
    }

    async function addAutoBuyRuleToServer(keyword, ca, amount, twitterUsers = []) {
        try {
            const res = await fetch(AUTOBUY_API, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ keyword, ca, amount, twitterUsers, token: SECRET_TOKEN })
            });
            const data = await res.json();
            if (data.success) autoBuyRules = data.rules || [];
            return data;
        } catch (e) {
            console.error('[自动买入] 添加失败:', e);
            return { success: false, error: e.message };
        }
    }

    async function removeAutoBuyRuleFromServer(index) {
        try {
            const res = await fetch(AUTOBUY_API, {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ index, token: SECRET_TOKEN })
            });
            const data = await res.json();
            if (data.success) autoBuyRules = data.rules || [];
            return data;
        } catch (e) {
            console.error('[自动买入] 删除失败:', e);
            return { success: false, error: e.message };
        }
    }

    // ==================== 推特账号管理（服务器同步） ====================
    const TWITTER_API = API_URL + '?type=twitter';
    let twitterUsers = [];  // 缓存推特账号列表

    async function loadTwitterUsersFromServer() {
        try {
            const res = await fetch(TWITTER_API);
            const data = await res.json();
            if (data.success) {
                twitterUsers = data.rules || [];  // API 返回的是 rules 字段
                console.log('[推特账号] 从服务器加载:', twitterUsers.length, '个账号');
            }
        } catch (e) {
            console.error('[推特账号] 加载失败:', e);
        }
        return twitterUsers;
    }

    async function addTwitterUserToServer(username, note = '') {
        try {
            const res = await fetch(TWITTER_API, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, note, token: SECRET_TOKEN })
            });
            const data = await res.json();
            if (data.success) twitterUsers = data.rules || [];
            return data;
        } catch (e) {
            console.error('[推特账号] 添加失败:', e);
            return { success: false, error: e.message };
        }
    }

    async function removeTwitterUserFromServer(index) {
        try {
            const res = await fetch(TWITTER_API, {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ index, token: SECRET_TOKEN })
            });
            const data = await res.json();
            if (data.success) twitterUsers = data.rules || [];
            return data;
        } catch (e) {
            console.error('[推特账号] 删除失败:', e);
            return { success: false, error: e.message };
        }
    }

    function getTwitterUsers() {
        return twitterUsers;
    }

    async function toggleAutoBuyRule(index, enabled) {
        try {
            const res = await fetch(AUTOBUY_API, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ index, enabled, token: SECRET_TOKEN })
            });
            const data = await res.json();
            if (data.success) autoBuyRules = data.rules || [];
            return data;
        } catch (e) {
            console.error('[自动买入] 切换失败:', e);
            return { success: false, error: e.message };
        }
    }

    async function setAllAutoBuyRulesEnabled(enableAll) {
        try {
            const res = await fetch(AUTOBUY_API, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enableAll, token: SECRET_TOKEN })
            });
            const data = await res.json();
            if (data.success) autoBuyRules = data.rules || [];
            return data;
        } catch (e) {
            console.error('[自动买入] 批量设置失败:', e);
            return { success: false, error: e.message };
        }
    }

    function getAutoBuyRules() {
        return autoBuyRules;
    }

    // 本地勾选状态管理
    function getLocalAutoBuyEnabled() {
        return JSON.parse(localStorage.getItem('wss-autobuy-local-enabled') || '{}');
    }
    function setLocalAutoBuyEnabled(keyword, enabled) {
        const local = getLocalAutoBuyEnabled();
        local[keyword] = enabled;
        localStorage.setItem('wss-autobuy-local-enabled', JSON.stringify(local));
    }
    function isRuleLocalEnabled(rule) {
        const local = getLocalAutoBuyEnabled();
        // 如果本地没有设置，默认使用服务器的 enabled 状态
        if (local[rule.keyword] === undefined) {
            return rule.enabled !== false;
        }
        return local[rule.keyword];
    }

    function isAutoBuyEnabled() {
        return localStorage.getItem('wss-autobuy-enabled') === 'true';
    }
    function setAutoBuyEnabled(enabled) {
        localStorage.setItem('wss-autobuy-enabled', enabled ? 'true' : 'false');
        updateAutoBuyToggle();
    }

    let autoBuyExecuted = new Map(); // 防止重复买入，记录执行时间 { buyKey: timestamp }
    let nonceOffset = 0; // 用于并发内盘买入时的 nonce 偏移
    const AUTOBUY_COOLDOWN = 30000; // 30秒内跳过重复

    function updateAutoBuyToggle() {
        const toggle = document.getElementById('autobuy-toggle');
        if (toggle) {
            toggle.checked = isAutoBuyEnabled();
        }
        const indicator = document.getElementById('autobuy-indicator');
        if (indicator) {
            indicator.style.background = isAutoBuyEnabled() ? '#0f0' : '#666';
            indicator.title = isAutoBuyEnabled() ? '自动买入已开启' : '自动买入已关闭';
        }
    }

    function checkAutoBuy(text, originalText = '', currentUrl = '', originalUrl = '', author = '', originalAuthor = '') {
        if (!isAutoBuyEnabled()) return;
        const rules = getAutoBuyRules();
        if (rules.length === 0) return;

        // 清理过期的防重复记录
        const now = Date.now();
        for (const [key, ts] of autoBuyExecuted) {
            if (now - ts > AUTOBUY_COOLDOWN) autoBuyExecuted.delete(key);
        }

        // 匹配 text、originalText、currentUrl、originalUrl、author、originalAuthor
        const textTarget = (text + ' ' + originalText).toLowerCase();
        const urlTarget = (currentUrl + ' ' + originalUrl).toLowerCase();
        const authorTarget = (author + ' ' + (originalAuthor || '')).toLowerCase();

        console.log(`[自动买入] 检查匹配 | text: "${text.slice(0,50)}..." | author: @${author} | rules: ${rules.length}条`);

        // 收集所有匹配的规则
        const matchedRules = [];

        for (const rule of rules) {
            // 使用本地勾选状态
            if (!isRuleLocalEnabled(rule)) {
                console.log(`[自动买入] 规则 "${rule.keyword}" 未启用，跳过`);
                continue;
            }

            // 检查推特账号限制（如果指定了）
            if (rule.twitterUsers && Array.isArray(rule.twitterUsers) && rule.twitterUsers.length > 0) {
                const targetUsers = rule.twitterUsers.map(u => u.toLowerCase().replace('@', '').trim());
                const currentAuthor = author.toLowerCase().replace('@', '').trim();
                const origAuthor = (originalAuthor || '').toLowerCase().replace('@', '').trim();

                // 必须是指定用户之一发布的（包括原推或转发的原推）
                const isTargetUser = targetUsers.includes(currentAuthor) || targetUsers.includes(origAuthor);

                if (!isTargetUser) {
                    console.log(`[自动买入] 规则 "${rule.keyword}" 要求推特账号 [${rule.twitterUsers.join(', ')}]，当前 @${author}，跳过`);
                    continue;
                }

                const matchedUser = targetUsers.includes(currentAuthor) ? currentAuthor : origAuthor;
                console.log(`[自动买入] ✓ 推特账号匹配: @${matchedUser}`);
            } else if (rule.twitterUser && rule.twitterUser.trim() !== '') {
                // 兼容旧版本单个账号格式
                const targetUser = rule.twitterUser.toLowerCase().replace('@', '').trim();
                const currentAuthor = author.toLowerCase().replace('@', '').trim();
                const origAuthor = (originalAuthor || '').toLowerCase().replace('@', '').trim();

                const isTargetUser = currentAuthor === targetUser || origAuthor === targetUser;

                if (!isTargetUser) {
                    console.log(`[自动买入] 规则 "${rule.keyword}" 要求推特账号 @${targetUser}，当前 @${author}，跳过`);
                    continue;
                }

                console.log(`[自动买入] ✓ 推特账号匹配: @${targetUser}`);
            }

            const keyword = rule.keyword.toLowerCase();
            const matchText = textTarget.includes(keyword);
            const matchUrl = urlTarget.includes(keyword);
            const matchAuthor = authorTarget.includes(keyword);

            if (matchText || matchUrl || matchAuthor) {
                const buyKey = `${rule.keyword}-${rule.ca}`;
                const lastExecuted = autoBuyExecuted.get(buyKey);
                const now = Date.now();

                // 30秒内跳过重复
                if (lastExecuted && (now - lastExecuted) < AUTOBUY_COOLDOWN) {
                    const remaining = Math.ceil((AUTOBUY_COOLDOWN - (now - lastExecuted)) / 1000);
                    console.log(`[自动买入] 跳过重复: ${rule.keyword} (${remaining}秒后可再次执行)`);
                    continue;
                }

                autoBuyExecuted.set(buyKey, now);
                matchedRules.push(rule);
                console.log(`[自动买入] ✓ 匹配规则: "${rule.keyword}" | matchText: ${matchText} | matchUrl: ${matchUrl} | matchAuthor: ${matchAuthor}`);
            }
        }

        if (matchedRules.length === 0) {
            console.log(`[自动买入] 无匹配规则`);
            return;
        }

        console.log(`[自动买入] 共匹配 ${matchedRules.length} 条规则:`, matchedRules.map(r => `${r.keyword}→${r.ca.slice(0,8)}`).join(', '));

        if (matchedRules.length > 1) {
            showTradeStatus(`⚡ 自动买入 ${matchedRules.length} 条规则...`, 'loading');
        }

        // 真正并发执行买入
        // 内盘：每个规则使用不同的 nonce 偏移量
        // 外盘：直接并发，服务器会处理
        console.log(`[自动买入] 并发执行 ${matchedRules.length} 条规则`);

        const buyPromises = matchedRules.map((rule, index) => {
            const startTime = Date.now();
            console.log(`[自动买入] 并发启动 [${index + 1}/${matchedRules.length}]: ${rule.keyword} → ${rule.ca} (${rule.amount} BNB) | nonceOffset: ${index}`);

            // 传入 nonceOffset，内盘买入时每个规则的 nonce 递增
            return quickBuy(rule.ca, rule.amount, index)
                .then(() => {
                    const elapsed = Date.now() - startTime;
                    const time = new Date().toLocaleTimeString([], { hour12: false });
                    console.log(`[自动买入] ✅ 成功 [${index + 1}]: ${rule.keyword} (${elapsed}ms)`);

                    addMessageToHistory(
                        'system',
                        time,
                        '自动买入',
                        'AutoBuy',
                        '',
                        `✅ ${rule.keyword} → ${rule.ca.slice(0,6)}...${rule.ca.slice(-4)} | ${rule.amount} BNB | 耗时 ${elapsed}ms`,
                        '',
                        '',
                        '',
                        false,
                        'autobuy-success-' + Date.now() + '-' + rule.keyword
                    );
                    return { success: true, keyword: rule.keyword, elapsed };
                })
                .catch(e => {
                    const elapsed = Date.now() - startTime;
                    const time = new Date().toLocaleTimeString([], { hour12: false });
                    console.error(`[自动买入] ❌ 失败 [${index + 1}]: ${rule.keyword} (${elapsed}ms)`, e);

                    addMessageToHistory(
                        'system',
                        time,
                        '自动买入',
                        'AutoBuy',
                        '',
                        `❌ ${rule.keyword} 失败: ${e.message} | 耗时 ${elapsed}ms`,
                        '',
                        '',
                        '',
                        false,
                        'autobuy-fail-' + Date.now() + '-' + rule.keyword
                    );
                    return { success: false, keyword: rule.keyword, error: e.message };
                });
        });

        // 等待所有并发买入完成
        Promise.all(buyPromises).then(results => {
            const successCount = results.filter(r => r.success).length;
            const failCount = results.filter(r => !r.success).length;
            const totalElapsed = Math.max(...results.map(r => r.elapsed || 0));
            console.log(`[自动买入] 全部完成: ${successCount}成功, ${failCount}失败, 总耗时 ${totalElapsed}ms`);

            if (results.length > 1) {
                showTradeStatus(`✅ 并发买入完成: ${successCount}成功, ${failCount}失败 (${totalElapsed}ms)`, successCount > 0 ? 'success' : 'error');
            } else if (results.length === 1) {
                const r = results[0];
                showTradeStatus(r.success ? `✅ 自动买入成功: ${r.keyword} (${r.elapsed}ms)` : `❌ 自动买入失败: ${r.keyword}`, r.success ? 'success' : 'error');
            }
        });
    }

    function showAutoBuyPanel() {
        const panel = document.createElement('div');
        Object.assign(panel.style, { position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', width: '450px', maxHeight: '80vh', background: 'rgba(30,30,45,0.98)', border: '1px solid #555', borderRadius: '10px', padding: '16px', color: '#eee', zIndex: '999999', overflowY: 'auto' });

        panel.innerHTML = `
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
                <span style="color:#f90;font-weight:bold;font-size:15px;">⚡ 自动买入规则 (服务器同步，本地勾选)</span>
                <button id="close-autobuy" style="background:none;border:none;color:#888;font-size:18px;cursor:pointer;">×</button>
            </div>
            <div style="color:#aaa;font-size:11px;margin-bottom:10px;">规则从服务器同步，勾选状态保存在本地。可选指定推特账号。</div>
            <div style="display:flex;gap:6px;margin-bottom:10px;">
                <button id="select-all-ab" style="padding:4px 10px;background:#0c6;border:none;color:#fff;border-radius:4px;font-size:11px;cursor:pointer;">全选</button>
                <button id="deselect-all-ab" style="padding:4px 10px;background:#666;border:none;color:#fff;border-radius:4px;font-size:11px;cursor:pointer;">全不选</button>
                <button id="refresh-ab" style="padding:4px 10px;background:#1d9bf0;border:none;color:#fff;border-radius:4px;font-size:11px;cursor:pointer;">刷新</button>
            </div>
            <div id="autobuy-list" style="margin-bottom:12px;max-height:220px;overflow-y:auto;"></div>
            <div style="border-top:1px solid #444;padding-top:12px;">
                <div style="color:#aaa;font-size:11px;margin-bottom:6px;">添加新规则</div>
                <div style="display:flex;gap:6px;margin-bottom:6px;">
                    <input id="ab-keyword" placeholder="关键词" style="width:80px;padding:5px;background:#1e1e2e;border:1px solid #444;color:#eee;border-radius:4px;font-size:11px;">
                    <input id="ab-ca" placeholder="CA地址 0x..." style="flex:1;padding:5px;background:#1e1e2e;border:1px solid #444;color:#eee;border-radius:4px;font-size:11px;">
                    <input id="ab-amount" type="number" step="0.01" placeholder="BNB" value="0.1" style="width:60px;padding:5px;background:#1e1e2e;border:1px solid #444;color:#eee;border-radius:4px;font-size:11px;">
                </div>
                <div style="margin-bottom:6px;">
                    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
                        <span style="color:#aaa;font-size:10px;">推特账号（可选，支持多选）</span>
                        <button id="manage-twitter-btn" style="padding:2px 6px;background:rgba(29,155,240,0.3);border:none;color:#1d9bf0;border-radius:3px;font-size:10px;cursor:pointer;">管理账号</button>
                    </div>
                    <div id="selected-twitter-tags" style="min-height:28px;padding:4px;background:#1e1e2e;border:1px solid #444;border-radius:4px;display:flex;flex-wrap:wrap;gap:4px;align-items:center;">
                        <button id="add-twitter-tag-btn" style="padding:2px 6px;background:rgba(29,155,240,0.2);border:1px dashed rgba(29,155,240,0.5);color:#1d9bf0;border-radius:3px;font-size:10px;cursor:pointer;">+ 选择账号</button>
                    </div>
                </div>
                <button id="add-autobuy" style="width:100%;padding:6px;background:#f90;border:none;color:#fff;border-radius:4px;font-size:12px;cursor:pointer;font-weight:bold;">添加规则</button>
            </div>
        `;

        document.body.appendChild(panel);

        // 已选择的推特账号列表
        let selectedTwitterUsers = [];

        // 更新标签显示
        function updateTwitterTags() {
            const container = panel.querySelector('#selected-twitter-tags');
            const addBtn = panel.querySelector('#add-twitter-tag-btn');

            // 清空容器（保留添加按钮）
            container.innerHTML = '';

            // 添加已选择的标签
            selectedTwitterUsers.forEach((username, index) => {
                const tag = document.createElement('span');
                tag.style.cssText = 'padding:3px 8px;background:rgba(29,155,240,0.2);border:1px solid rgba(29,155,240,0.4);border-radius:3px;font-size:10px;color:#1d9bf0;display:flex;align-items:center;gap:4px;';
                tag.innerHTML = `
                    @${username}
                    <span style="cursor:pointer;color:#ff6b6b;font-weight:bold;" data-index="${index}">×</span>
                `;

                // 绑定删除事件
                tag.querySelector('span[data-index]').onclick = (e) => {
                    e.stopPropagation();
                    selectedTwitterUsers.splice(index, 1);
                    updateTwitterTags();
                };

                container.appendChild(tag);
            });

            // 重新添加"添加按钮"
            container.appendChild(addBtn);
        }

        // 显示推特账号多选菜单
        function showTwitterMultiSelectMenu() {
            const users = getTwitterUsers();

            if (users.length === 0) {
                showTwitterManagePanel();
                return;
            }

            // 移除旧菜单
            const oldMenu = document.getElementById('twitter-multiselect-menu');
            if (oldMenu) oldMenu.remove();

            const menu = document.createElement('div');
            menu.id = 'twitter-multiselect-menu';
            Object.assign(menu.style, {
                position: 'fixed',
                top: '50%',
                left: '50%',
                transform: 'translate(-50%, -50%)',
                background: 'rgba(30,30,45,0.98)',
                border: '1px solid #555',
                borderRadius: '8px',
                padding: '12px',
                zIndex: '1000000',
                minWidth: '250px',
                maxHeight: '400px',
                overflowY: 'auto'
            });

            menu.innerHTML = `
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
                    <span style="color:#1d9bf0;font-weight:bold;font-size:13px;">选择推特账号（多选）</span>
                    <button id="close-multiselect-menu" style="background:none;border:none;color:#888;font-size:16px;cursor:pointer;">×</button>
                </div>
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                    <span style="color:#aaa;font-size:10px;">已选 ${selectedTwitterUsers.length} 个</span>
                    <div style="display:flex;gap:4px;">
                        <button id="select-all-twitter" style="padding:2px 6px;background:rgba(12,204,102,0.3);border:none;color:#0c6;border-radius:3px;font-size:10px;cursor:pointer;">全选</button>
                        <button id="clear-all-twitter" style="padding:2px 6px;background:rgba(255,107,107,0.3);border:none;color:#ff6b6b;border-radius:3px;font-size:10px;cursor:pointer;">清空</button>
                        <button id="manage-twitter-btn2" style="padding:2px 6px;background:rgba(29,155,240,0.3);border:none;color:#1d9bf0;border-radius:3px;font-size:10px;cursor:pointer;">管理</button>
                    </div>
                </div>
                <div id="twitter-checkbox-list" style="max-height:250px;overflow-y:auto;">
                    ${users.map(u => {
                        const isSelected = selectedTwitterUsers.includes(u.username);
                        const noteDisplay = u.note ? `<span style="color:#666;font-size:9px;margin-left:4px;">${u.note}</span>` : '';
                        return `
                            <label style="display:flex;align-items:center;padding:6px 8px;background:${isSelected ? 'rgba(29,155,240,0.15)' : 'rgba(50,50,70,0.3)'};border:1px solid ${isSelected ? 'rgba(29,155,240,0.4)' : 'rgba(100,100,100,0.3)'};border-radius:4px;margin-bottom:4px;cursor:pointer;font-size:11px;color:#eee;">
                                <input type="checkbox" value="${u.username}" ${isSelected ? 'checked' : ''} style="margin-right:8px;width:14px;height:14px;cursor:pointer;">
                                <span>@${u.username}${noteDisplay}</span>
                            </label>
                        `;
                    }).join('')}
                </div>
                <button id="confirm-twitter-selection" style="width:100%;margin-top:10px;padding:6px;background:#1d9bf0;border:none;color:#fff;border-radius:4px;font-size:11px;cursor:pointer;font-weight:bold;">确定</button>
            `;

            document.body.appendChild(menu);

            // 绑定复选框事件
            menu.querySelectorAll('input[type="checkbox"]').forEach(cb => {
                cb.onchange = () => {
                    const username = cb.value;
                    if (cb.checked) {
                        if (!selectedTwitterUsers.includes(username)) {
                            selectedTwitterUsers.push(username);
                        }
                    } else {
                        const idx = selectedTwitterUsers.indexOf(username);
                        if (idx > -1) {
                            selectedTwitterUsers.splice(idx, 1);
                        }
                    }
                    // 更新已选数量显示
                    menu.querySelector('span[style*="已选"]').textContent = `已选 ${selectedTwitterUsers.length} 个`;
                    // 更新背景色
                    cb.closest('label').style.background = cb.checked ? 'rgba(29,155,240,0.15)' : 'rgba(50,50,70,0.3)';
                    cb.closest('label').style.borderColor = cb.checked ? 'rgba(29,155,240,0.4)' : 'rgba(100,100,100,0.3)';
                };
            });

            // 全选
            menu.querySelector('#select-all-twitter').onclick = () => {
                selectedTwitterUsers = users.map(u => u.username);
                menu.querySelectorAll('input[type="checkbox"]').forEach(cb => {
                    cb.checked = true;
                    cb.closest('label').style.background = 'rgba(29,155,240,0.15)';
                    cb.closest('label').style.borderColor = 'rgba(29,155,240,0.4)';
                });
                menu.querySelector('span[style*="已选"]').textContent = `已选 ${selectedTwitterUsers.length} 个`;
            };

            // 清空
            menu.querySelector('#clear-all-twitter').onclick = () => {
                selectedTwitterUsers = [];
                menu.querySelectorAll('input[type="checkbox"]').forEach(cb => {
                    cb.checked = false;
                    cb.closest('label').style.background = 'rgba(50,50,70,0.3)';
                    cb.closest('label').style.borderColor = 'rgba(100,100,100,0.3)';
                });
                menu.querySelector('span[style*="已选"]').textContent = `已选 0 个`;
            };

            // 管理账号
            menu.querySelector('#manage-twitter-btn2').onclick = () => {
                menu.remove();
                showTwitterManagePanel();
            };

            // 确定
            menu.querySelector('#confirm-twitter-selection').onclick = () => {
                updateTwitterTags();
                menu.remove();
            };

            // 关闭
            menu.querySelector('#close-multiselect-menu').onclick = () => menu.remove();

            // 点击外部关闭
            setTimeout(() => {
                const closeOnClickOutside = (e) => {
                    if (!menu.contains(e.target) && e.target.id !== 'add-twitter-tag-btn') {
                        menu.remove();
                        document.removeEventListener('click', closeOnClickOutside);
                    }
                };
                document.addEventListener('click', closeOnClickOutside);
            }, 100);
        }

        // 绑定"选择账号"按钮
        panel.querySelector('#add-twitter-tag-btn').onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            showTwitterMultiSelectMenu();
        };

        // 绑定"管理账号"按钮
        panel.querySelector('#manage-twitter-btn').onclick = () => {
            showTwitterManagePanel();
        };

        // 提取所有已使用的推特账号（从服务器）
        function getUsedTwitterUsers() {
            const users = getTwitterUsers();
            return users.map(u => u.username).sort();
        }

        async function renderList() {
            const list = panel.querySelector('#autobuy-list');
            list.innerHTML = '<div style="color:#666;font-size:11px;text-align:center;padding:12px;">加载中...</div>';

            const currentRules = getAutoBuyRules();
            if (currentRules.length === 0) {
                list.innerHTML = '<div style="color:#666;font-size:11px;text-align:center;padding:12px;">暂无自动买入规则</div>';
                return;
            }
            list.innerHTML = currentRules.map((r, i) => {
                const isEnabled = isRuleLocalEnabled(r);

                // 显示推特账号（支持多个）
                let twitterUserDisplay = '';
                if (r.twitterUsers && Array.isArray(r.twitterUsers) && r.twitterUsers.length > 0) {
                    // 新格式：多个账号
                    twitterUserDisplay = `<span style="color:#888;margin-left:4px;">@${r.twitterUsers.join(', @')}</span>`;
                } else if (r.twitterUser) {
                    // 旧格式：单个账号
                    twitterUserDisplay = `<span style="color:#888;margin-left:4px;">@${r.twitterUser}</span>`;
                }

                return `
                <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 8px;background:${isEnabled ? 'rgba(255,153,0,0.15)' : 'rgba(100,100,100,0.1)'};border:1px solid ${isEnabled ? 'rgba(255,153,0,0.4)' : 'rgba(100,100,100,0.3)'};border-radius:4px;margin-bottom:4px;">
                    <div style="display:flex;align-items:center;gap:8px;font-size:11px;">
                        <input type="checkbox" data-keyword="${r.keyword}" class="toggle-ab" ${isEnabled ? 'checked' : ''} style="width:14px;height:14px;cursor:pointer;">
                        <div>
                            <b style="color:${isEnabled ? '#f90' : '#888'};">${r.keyword}</b>
                            ${twitterUserDisplay}
                            <span style="color:#666;margin:0 4px;">→</span>
                            <span style="color:#1d9bf0;">${r.ca.slice(0,6)}...${r.ca.slice(-4)}</span>
                            <span style="color:#0c6;margin-left:6px;">${r.amount} BNB</span>
                        </div>
                    </div>
                    <button data-idx="${i}" class="del-ab" style="background:#c44;border:none;color:#fff;padding:2px 6px;border-radius:3px;font-size:10px;cursor:pointer;">删</button>
                </div>
            `}).join('');
            // 绑定切换事件（本地存储）
            list.querySelectorAll('.toggle-ab').forEach(cb => {
                cb.onchange = () => {
                    const keyword = cb.dataset.keyword;
                    setLocalAutoBuyEnabled(keyword, cb.checked);
                    renderList();
                };
            });

            // 绑定删除事件
            list.querySelectorAll('.del-ab').forEach(btn => {
                btn.onclick = async () => {
                    const idx = parseInt(btn.dataset.idx);
                    btn.disabled = true;
                    btn.textContent = '...';
                    await removeAutoBuyRuleFromServer(idx);
                    renderList();
                };
            });
        }
        renderList();

        // 全选（本地）
        panel.querySelector('#select-all-ab').onclick = () => {
            const currentRules = getAutoBuyRules();
            currentRules.forEach(r => setLocalAutoBuyEnabled(r.keyword, true));
            renderList();
        };

        // 全不选（本地）
        panel.querySelector('#deselect-all-ab').onclick = () => {
            const currentRules = getAutoBuyRules();
            currentRules.forEach(r => setLocalAutoBuyEnabled(r.keyword, false));
            renderList();
        };

        // 刷新
        panel.querySelector('#refresh-ab').onclick = async () => {
            await loadAutoBuyRulesFromServer();
            renderList();
        };

        // 添加规则
        panel.querySelector('#add-autobuy').onclick = async () => {
            const keyword = panel.querySelector('#ab-keyword').value.trim();
            const ca = panel.querySelector('#ab-ca').value.trim();
            const amount = parseFloat(panel.querySelector('#ab-amount').value) || 0.1;

            if (!keyword || !ca) return alert('请填写关键词和CA');

            const btn = panel.querySelector('#add-autobuy');
            btn.disabled = true;
            btn.textContent = '添加中...';

            // 使用选中的推特账号数组
            const result = await addAutoBuyRuleToServer(keyword, ca, amount, selectedTwitterUsers);

            btn.disabled = false;
            btn.textContent = '添加规则';

            if (result.success) {
                panel.querySelector('#ab-keyword').value = '';
                panel.querySelector('#ab-ca').value = '';
                panel.querySelector('#ab-amount').value = '0.1';
                // 清空选中的推特账号
                selectedTwitterUsers = [];
                updateTwitterTags();
                renderList();
            } else {
                alert('添加失败: ' + (result.error || '未知错误'));
            }
        };

        panel.querySelector('#close-autobuy').onclick = () => panel.remove();
    }

    // ==================== UI: 主浮动框 ====================
    function createFloatingBox() {
        // 移除旧的浮动框（如果存在）
        const oldBox = document.getElementById('wss-float');
        if (oldBox) oldBox.remove();

        const box = document.createElement('div');
        box.id = 'wss-float';
        Object.assign(box.style, { position: 'fixed', background: 'rgba(25,25,40,0.96)', border: '1px solid #555', borderRadius: '10px', color: '#ddd', fontFamily: 'Segoe UI, sans-serif', fontSize: '13px', overflow: 'hidden', zIndex: '999999', boxShadow: '0 6px 24px rgba(0,0,0,0.7)', resize: 'both', display: 'none', flexDirection: 'column' });

        // Header
        const header = document.createElement('div');
        Object.assign(header.style, { background: '#1a1a2e', padding: '8px 12px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid #444', cursor: 'move' });

        const title = document.createElement('div');
        title.innerHTML = '<span style="color:#0f0;font-weight:bold;">WSS 监控</span>';
        header.appendChild(title);

        const btnGroup = document.createElement('div');
        btnGroup.style.display = 'flex';
        btnGroup.style.gap = '6px';

        const ruleBtn = document.createElement('button');
        ruleBtn.textContent = '规则';
        Object.assign(ruleBtn.style, { padding: '2px 8px', background: 'rgba(29,155,240,0.25)', border: '1px solid #1d9bf0', color: '#1d9bf0', borderRadius: '4px', fontSize: '11px', cursor: 'pointer' });
        ruleBtn.onclick = showRulePanel;
        btnGroup.appendChild(ruleBtn);

        const autoBuyBtn = document.createElement('button');
        autoBuyBtn.textContent = '自动';
        Object.assign(autoBuyBtn.style, { padding: '2px 8px', background: 'rgba(255,153,0,0.25)', border: '1px solid #f90', color: '#f90', borderRadius: '4px', fontSize: '11px', cursor: 'pointer' });
        autoBuyBtn.onclick = showAutoBuyPanel;
        btnGroup.appendChild(autoBuyBtn);

        const settingBtn = document.createElement('button');
        settingBtn.textContent = '设置';
        Object.assign(settingBtn.style, { padding: '2px 8px', background: 'rgba(0,200,83,0.25)', border: '1px solid #0c6', color: '#0c6', borderRadius: '4px', fontSize: '11px', cursor: 'pointer' });
        settingBtn.onclick = showSettingPanel;
        btnGroup.appendChild(settingBtn);

        const closeBtn = document.createElement('button');
        closeBtn.textContent = '收起';
        Object.assign(closeBtn.style, { padding: '2px 8px', background: 'transparent', border: 'none', color: '#aaa', cursor: 'pointer', fontSize: '11px' });
        closeBtn.onclick = () => { box.style.display = 'none'; wakeBtn.style.display = 'flex'; saveBoxState(); };
        btnGroup.appendChild(closeBtn);

        header.appendChild(btnGroup);
        box.appendChild(header);

        // 钱包选择栏
        const walletBar = document.createElement('div');
        walletBar.id = 'wallet-selector-bar';
        Object.assign(walletBar.style, { padding: '6px 10px', fontSize: '11px', background: 'rgba(0,0,0,0.2)', borderBottom: '1px solid #333', display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' });
        walletBar.innerHTML = '<span style="color:#888;">💼</span>';
        box.appendChild(walletBar);

        // 状态栏
        const statusBar = document.createElement('div');
        statusBar.id = 'trade-status';
        Object.assign(statusBar.style, { padding: '6px 12px', fontSize: '12px', color: '#888', borderBottom: '1px solid #333', display: 'none' });
        box.appendChild(statusBar);

        // 消息内容区
        const content = document.createElement('div');
        content.id = 'wss-content';
        Object.assign(content.style, { flex: '1', minHeight: '0', overflowY: 'auto', padding: '8px' });
        box.appendChild(content);

        document.body.appendChild(box);

        // 拖拽
        let isDragging = false, initialX, initialY;
        header.addEventListener('mousedown', e => { if (e.target.tagName === 'BUTTON') return; isDragging = true; initialX = e.clientX - box.offsetLeft; initialY = e.clientY - box.offsetTop; });
        document.addEventListener('mousemove', e => { if (isDragging) { box.style.left = (e.clientX - initialX) + 'px'; box.style.top = (e.clientY - initialY) + 'px'; box.style.right = 'auto'; box.style.bottom = 'auto'; } });
        document.addEventListener('mouseup', () => { if (isDragging) { isDragging = false; saveBoxState(); } });

        loadBoxState(box);
        floatBox = box;
        historyContent = content;
        return { box, content };
    }

    // 更新钱包选择器
    function updateWalletSelector() {
        const bar = document.getElementById('wallet-selector-bar');
        if (!bar) return;
        const wallets = JSON.parse(localStorage.getItem('wss-wallets') || '[]');
        const selected = JSON.parse(localStorage.getItem('wss-selected-wallets') || '[]');

        bar.innerHTML = '<span style="color:#888;font-size:10px;">💼</span>';
        if (wallets.length === 0) {
            bar.innerHTML += '<span style="color:#666;font-size:10px;">无钱包，请在设置中添加</span>';
            return;
        }
        wallets.forEach(w => {
            const isSelected = selected.includes(w.name);
            const chip = document.createElement('label');
            chip.style.cssText = `display:inline-flex;align-items:center;gap:3px;padding:2px 6px;background:${isSelected ? 'rgba(29,155,240,0.3)' : 'rgba(255,255,255,0.1)'};border-radius:4px;cursor:pointer;font-size:10px;`;
            chip.innerHTML = `<input type="checkbox" ${isSelected ? 'checked' : ''} style="width:12px;height:12px;margin:0;"><span>${w.name}</span>`;
            chip.querySelector('input').onchange = (e) => {
                let sel = JSON.parse(localStorage.getItem('wss-selected-wallets') || '[]');
                if (e.target.checked) {
                    if (!sel.includes(w.name)) sel.push(w.name);
                } else {
                    sel = sel.filter(n => n !== w.name);
                }
                localStorage.setItem('wss-selected-wallets', JSON.stringify(sel));
                updateWalletSelector();
            };
            bar.appendChild(chip);
        });

        // 自动买入开关
        const autoBuyEnabled = isAutoBuyEnabled();
        const autoBuyToggle = document.createElement('label');
        autoBuyToggle.style.cssText = 'display:inline-flex;align-items:center;gap:3px;padding:2px 6px;background:rgba(255,153,0,0.2);border-radius:4px;cursor:pointer;font-size:10px;margin-left:auto;';
        autoBuyToggle.innerHTML = `
            <span id="autobuy-indicator" style="width:8px;height:8px;border-radius:50%;background:${autoBuyEnabled ? '#0f0' : '#666'};" title="${autoBuyEnabled ? '自动买入已开启' : '自动买入已关闭'}"></span>
            <input id="autobuy-toggle" type="checkbox" ${autoBuyEnabled ? 'checked' : ''} style="width:12px;height:12px;margin:0;">
            <span style="color:#f90;">自动</span>
        `;
        autoBuyToggle.querySelector('input').onchange = (e) => {
            setAutoBuyEnabled(e.target.checked);
        };
        bar.appendChild(autoBuyToggle);
    }

    function saveBoxState() { localStorage.setItem('wss-box-state', JSON.stringify({ left: floatBox.style.left, top: floatBox.style.top, width: floatBox.offsetWidth + 'px', height: floatBox.offsetHeight + 'px' })); }
    function loadBoxState(box) {
        const saved = localStorage.getItem('wss-box-state');
        if (saved) { const s = JSON.parse(saved); box.style.left = s.left; box.style.top = s.top; box.style.width = s.width || '420px'; box.style.height = s.height || '500px'; box.style.right = 'auto'; box.style.bottom = 'auto'; }
        else { box.style.left = (window.innerWidth - 460) + 'px'; box.style.top = '100px'; box.style.width = '420px'; box.style.height = '500px'; }
    }

    function showTradeStatus(msg, type) {
        const el = document.getElementById('trade-status');
        el.style.display = 'block';
        el.textContent = msg;
        el.style.color = type === 'success' ? '#0f0' : type === 'error' ? '#f66' : '#1d9bf0';
        if (type !== 'loading') setTimeout(() => el.style.display = 'none', 5000);
    }

    // ==================== 设置面板 ====================
    function getWallets() {
        return JSON.parse(localStorage.getItem('wss-wallets') || '[]');
    }
    function saveWallets(wallets) {
        localStorage.setItem('wss-wallets', JSON.stringify(wallets));
        updateWalletSelector();
    }

    function showSettingPanel() {
        const saved = JSON.parse(localStorage.getItem('wss-trade-settings') || '{}');
        const panel = document.createElement('div');
        Object.assign(panel.style, { position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', width: '420px', maxHeight: '85vh', background: 'rgba(30,30,45,0.98)', border: '1px solid #555', borderRadius: '10px', padding: '16px', color: '#eee', zIndex: '999999', overflowY: 'auto' });

        panel.innerHTML = `
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
                <span style="color:#0c6;font-weight:bold;font-size:15px;">⚙️ 交易设置</span>
                <button id="close-setting" style="background:none;border:none;color:#888;font-size:18px;cursor:pointer;">×</button>
            </div>

            <!-- 钱包管理 -->
            <div style="margin-bottom:12px;padding:10px;background:rgba(0,0,0,0.2);border-radius:6px;">
                <div style="color:#1d9bf0;font-size:12px;font-weight:bold;margin-bottom:8px;">💼 钱包管理</div>
                <div id="wallet-list" style="margin-bottom:8px;max-height:120px;overflow-y:auto;"></div>
                <div style="display:flex;gap:6px;">
                    <input id="new-wallet-name" placeholder="名称" style="width:80px;padding:5px;background:#1e1e2e;border:1px solid #444;color:#eee;border-radius:4px;font-size:11px;">
                    <input id="new-wallet-pk" type="password" placeholder="私钥 0x..." style="flex:1;padding:5px;background:#1e1e2e;border:1px solid #444;color:#eee;border-radius:4px;font-size:11px;">
                    <button id="add-wallet-btn" style="padding:5px 10px;background:#1d9bf0;border:none;color:#fff;border-radius:4px;font-size:11px;cursor:pointer;">添加</button>
                </div>
            </div>

            <div style="margin-bottom:10px;">
                <label style="display:block;color:#aaa;font-size:11px;margin-bottom:3px;">默认买入金额 (BNB)</label>
                <input id="setting-default-amt" type="number" step="0.01" value="${saved.defaultAmount || 0.1}" style="width:100%;padding:6px;background:#1e1e2e;border:1px solid #444;color:#eee;border-radius:4px;font-size:12px;">
            </div>
            <div style="display:flex;gap:10px;margin-bottom:10px;">
                <div style="flex:1;">
                    <label style="display:block;color:#aaa;font-size:11px;margin-bottom:3px;">内盘 Gas (Gwei)</label>
                    <input id="setting-gas" type="number" step="0.1" value="${saved.innerGas || TRADE_CONFIG.INNER_GAS}" style="width:100%;padding:6px;background:#1e1e2e;border:1px solid #444;color:#eee;border-radius:4px;font-size:12px;">
                    <div style="color:#666;font-size:9px;margin-top:2px;">换算: ${saved.innerGas || TRADE_CONFIG.INNER_GAS} Gas = ${gasToBid(saved.innerGas || TRADE_CONFIG.INNER_GAS)} BID</div>
                </div>
                <div style="flex:1;">
                    <label style="display:block;color:#aaa;font-size:11px;margin-bottom:3px;">外盘贿赂 (BNB)</label>
                    <input id="setting-bid" type="number" step="0.0001" value="${saved.bid || TRADE_CONFIG.BID}" style="width:100%;padding:6px;background:#1e1e2e;border:1px solid #444;color:#eee;border-radius:4px;font-size:12px;">
                </div>
            </div>
            <div style="margin-bottom:10px;">
                <label style="display:block;color:#aaa;font-size:11px;margin-bottom:3px;">滑点 (%)</label>
                <input id="setting-slippage" type="number" step="1" min="1" max="100" value="${saved.slippage || TRADE_CONFIG.SLIPPAGE}" style="width:100%;padding:6px;background:#1e1e2e;border:1px solid #444;color:#eee;border-radius:4px;font-size:12px;">
            </div>
            <div style="margin-bottom:12px;">
                <label style="display:block;color:#aaa;font-size:11px;margin-bottom:3px;">规则黑名单 (逗号分隔)</label>
                <input id="setting-blacklist" value="${(saved.blacklist || []).join(',')}" placeholder="关键词1,关键词2" style="width:100%;padding:6px;background:#1e1e2e;border:1px solid #444;color:#eee;border-radius:4px;font-size:12px;">
            </div>
            <button id="save-setting" style="width:100%;padding:8px;background:#0c6;border:none;color:#fff;border-radius:6px;font-weight:bold;cursor:pointer;font-size:13px;">保存设置</button>
        `;

        document.body.appendChild(panel);

        // 渲染钱包列表
        function renderWalletList() {
            const list = panel.querySelector('#wallet-list');
            const currentWallets = getWallets();
            if (currentWallets.length === 0) {
                list.innerHTML = '<div style="color:#666;font-size:11px;text-align:center;padding:8px;">暂无钱包</div>';
                return;
            }
            list.innerHTML = currentWallets.map((w, i) => `
                <div style="display:flex;justify-content:space-between;align-items:center;padding:4px 6px;background:rgba(255,255,255,0.05);border-radius:4px;margin-bottom:4px;">
                    <span style="font-size:11px;"><b>${w.name}</b> <span style="color:#666;">${w.pk.slice(0,6)}...${w.pk.slice(-4)}</span></span>
                    <button data-idx="${i}" class="del-wallet" style="background:#c44;border:none;color:#fff;padding:2px 6px;border-radius:3px;font-size:10px;cursor:pointer;">删</button>
                </div>
            `).join('');
            list.querySelectorAll('.del-wallet').forEach(btn => {
                btn.onclick = () => {
                    const idx = parseInt(btn.dataset.idx);
                    const ws = getWallets();
                    ws.splice(idx, 1);
                    saveWallets(ws);
                    renderWalletList();
                };
            });
        }
        renderWalletList();

        // 添加钱包
        panel.querySelector('#add-wallet-btn').onclick = () => {
            const name = panel.querySelector('#new-wallet-name').value.trim();
            let pk = panel.querySelector('#new-wallet-pk').value.trim();
            if (!name || !pk) return alert('请填写名称和私钥');
            if (!pk.startsWith('0x')) pk = '0x' + pk;
            const ws = getWallets();
            if (ws.some(w => w.name === name)) return alert('名称已存在');
            ws.push({ name, pk });
            saveWallets(ws);
            panel.querySelector('#new-wallet-name').value = '';
            panel.querySelector('#new-wallet-pk').value = '';
            renderWalletList();
        };

        panel.querySelector('#close-setting').onclick = () => panel.remove();
        panel.querySelector('#save-setting').onclick = () => {
            const defaultAmount = parseFloat(panel.querySelector('#setting-default-amt').value) || 0.1;
            const innerGas = parseFloat(panel.querySelector('#setting-gas').value) || TRADE_CONFIG.INNER_GAS;
            const bid = panel.querySelector('#setting-bid').value || TRADE_CONFIG.BID;
            const slippage = parseInt(panel.querySelector('#setting-slippage').value) || TRADE_CONFIG.SLIPPAGE;
            const blacklistStr = panel.querySelector('#setting-blacklist').value.trim();
            const blacklist = blacklistStr ? blacklistStr.split(',').map(v => v.trim().toLowerCase()).filter(v => v) : [];
            localStorage.setItem('wss-trade-settings', JSON.stringify({ defaultAmount, innerGas, bid, slippage, blacklist }));
            showTradeStatus('✅ 设置已保存', 'success');
            panel.remove();
        };
    }

    function getTradeSettings() {
        const saved = JSON.parse(localStorage.getItem('wss-trade-settings') || '{}');
        return {
            defaultAmount: saved.defaultAmount || 0.1,
            innerGas: saved.innerGas || TRADE_CONFIG.INNER_GAS,
            bid: saved.bid || TRADE_CONFIG.BID,
            slippage: saved.slippage || TRADE_CONFIG.SLIPPAGE,
            blacklist: saved.blacklist || []
        };
    }

    // ==================== 价格查询（攒批） ====================
    const _priceCache = new Map(); // ca -> { data, ts }
    const _priceWaiters = new Map(); // ca -> [resolve]
    const _priceInFlight = new Set(); // 正在请求的 ca
    const PRICE_CACHE_TTL = 15000; // 15秒缓存
    const PRICE_BATCH_SIZE = 100; // OKX 这边单次可提交 100 条 CA
    const PRICE_FLUSH_DELAY = 80; // 短暂攒批，合并同一波消息的请求
    const PRICE_REQUEST_TIMEOUT = 8000;
    const PRICE_MAX_RETRY = 1;
    let _priceFlushTimer = null;
    function formatMcap(mcStr) {
        const mc = parseFloat(mcStr);
        if (isNaN(mc) || mc <= 0) return '';
        if (mc >= 1e6) return '$' + (mc / 1e6).toFixed(1) + 'M';
        if (mc >= 1e3) return '$' + (mc / 1e3).toFixed(1) + 'K';
        return '$' + mc.toFixed(0);
    }

    function formatTokenPrice(priceStr) {
        const price = parseFloat(priceStr);
        if (!Number.isFinite(price) || price <= 0) return '';
        if (price >= 1) return '$' + price.toFixed(4).replace(/\.?0+$/, '');
        if (price >= 0.01) return '$' + price.toFixed(6).replace(/\.?0+$/, '');
        return '$' + price.toPrecision(4);
    }

    function normalizePriceCAs(caList) {
        if (!Array.isArray(caList)) return [];
        return [...new Set(
            caList
                .filter(ca => typeof ca === 'string')
                .map(ca => ca.trim().toLowerCase())
                .filter(ca => /^0x[a-f0-9]{40}$/.test(ca))
        )];
    }

    function resolveQueuedPrice(ca, data) {
        const waiters = _priceWaiters.get(ca);
        if (!waiters || waiters.length === 0) return;
        _priceWaiters.delete(ca);
        waiters.forEach(resolve => resolve(data || null));
    }

    function schedulePriceFlush() {
        if (_priceFlushTimer) return;
        _priceFlushTimer = setTimeout(() => {
            _priceFlushTimer = null;
            flushPriceQueue();
        }, PRICE_FLUSH_DELAY);
    }

    function flushPriceQueue() {
        const pending = [..._priceWaiters.keys()].filter(ca => !_priceInFlight.has(ca));
        if (pending.length === 0) return;
        if (pending.length <= PRICE_BATCH_SIZE) {
            requestPriceBatch(pending);
            return;
        }
        for (let i = 0; i < pending.length; i += PRICE_BATCH_SIZE) {
            requestPriceBatch(pending.slice(i, i + PRICE_BATCH_SIZE));
        }
    }

    function requestPriceBatch(caBatch, attempt = 0) {
        const batch = normalizePriceCAs(caBatch).filter(ca => !_priceInFlight.has(ca));
        if (batch.length === 0) return;

        batch.forEach(ca => _priceInFlight.add(ca));
        const body = batch.map(ca => ({ chainIndex: "56", tokenContractAddress: ca }));
        console.log(`[OKX价格] 请求 ${batch.length} 个CA${attempt > 0 ? ` (重试${attempt})` : ''}`);

        const finishBatch = (resultMap = {}, { retry = false, reason = '', retryCas = [] } = {}) => {
            batch.forEach(ca => _priceInFlight.delete(ca));

            if (retry && attempt < PRICE_MAX_RETRY) {
                const retrySet = new Set(retryCas.length > 0 ? retryCas : batch);
                batch.forEach(ca => {
                    if (retrySet.has(ca)) return;
                    const fallback = resultMap[ca] || _priceCache.get(ca)?.data || null;
                    resolveQueuedPrice(ca, fallback);
                });
                console.warn(`[OKX价格] 批请求失败，准备重试: ${reason || 'unknown'}`);
                retrySet.forEach(ca => _priceInFlight.add(ca));
                setTimeout(() => {
                    retrySet.forEach(ca => _priceInFlight.delete(ca));
                    requestPriceBatch(retrySet.size > 0 ? [...retrySet] : batch, attempt + 1);
                }, 300);
                return;
            }

            batch.forEach(ca => {
                const fallback = resultMap[ca] || _priceCache.get(ca)?.data || null;
                resolveQueuedPrice(ca, fallback);
            });

            if (_priceWaiters.size > 0) schedulePriceFlush();
        };

        GM_xmlhttpRequest({
            method: 'POST',
            url: 'https://jbot.live/okx/okx_api.php?action=prices',
            headers: { 'Content-Type': 'application/json' },
            data: JSON.stringify(body),
            timeout: PRICE_REQUEST_TIMEOUT,
            onload: res => {
                let json;
                try {
                    json = JSON.parse(res.responseText);
                } catch (e) {
                    console.error('[OKX价格] 解析失败:', e);
                    finishBatch({}, { retry: true, reason: 'parse-error' });
                    return;
                }

                if (json.code !== "0" || !Array.isArray(json.data)) {
                    console.warn(`[OKX价格] 限流或异常(code=${json.code}), 当前批次稍后重试`);
                    finishBatch({}, { retry: true, reason: `code=${json.code}` });
                    return;
                }

                const map = {};
                const now = Date.now();
                json.data.forEach(item => {
                    const key = typeof item?.tokenContractAddress === 'string'
                        ? item.tokenContractAddress.toLowerCase()
                        : '';
                    if (!key) {
                        console.warn('[OKX价格] 忽略异常条目:', item);
                        return;
                    }
                    map[key] = item;
                    _priceCache.set(key, { data: item, ts: now });
                });

                const missing = batch.filter(ca => !map[ca]);
                console.log(`[OKX价格] 获取 ${Object.keys(map).length} 条价格${missing.length > 0 ? `, 缺失 ${missing.length} 条` : ''}`);

                if (missing.length > 0 && attempt < PRICE_MAX_RETRY) {
                    finishBatch(map, { retry: true, reason: `missing=${missing.length}`, retryCas: missing });
                    return;
                }

                finishBatch(map);
            },
            onerror: () => {
                console.error('[OKX价格] 请求失败');
                finishBatch({}, { retry: true, reason: 'network-error' });
            },
            ontimeout: () => {
                console.warn('[OKX价格] 请求超时');
                finishBatch({}, { retry: true, reason: 'timeout' });
            }
        });
    }

    // 一次性请求所有CA价格；内部会自动合并、分批、重试
    function fetchPrices(caList, callback) {
        const targets = normalizePriceCAs(caList);
        if (targets.length === 0) { callback({}); return; }

        const now = Date.now();
        const result = {};
        const pending = [];

        targets.forEach(ca => {
            const cached = _priceCache.get(ca);
            if (cached && now - cached.ts < PRICE_CACHE_TTL) {
                result[ca] = cached.data;
            } else {
                pending.push(ca);
            }
        });

        if (pending.length === 0) {
            callback(result);
            return;
        }

        Promise.all(pending.map(ca => new Promise(resolve => {
            const waiters = _priceWaiters.get(ca) || [];
            waiters.push(resolve);
            _priceWaiters.set(ca, waiters);
            schedulePriceFlush();
        }))).then(items => {
            items.forEach((item, idx) => {
                if (item) result[pending[idx]] = item;
            });
            callback(result);
        });
    }

    // ==================== 消息渲染 ====================
    function renderMessage(msg) {
        const row = document.createElement('div');
        Object.assign(row.style, { marginBottom: '8px', padding: '8px', background: 'rgba(255,255,255,0.03)', borderRadius: '6px', borderLeft: msg.isOriginal ? '3px solid #ffaa00' : '3px solid #00cc66' });

        // 头部: 头像 + 作者 + 时间 (更紧凑)
        const headerRow = document.createElement('div');
        Object.assign(headerRow.style, { display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' });
        if (msg.avatarUrl) { const img = document.createElement('img'); img.src = msg.avatarUrl; Object.assign(img.style, { width: '24px', height: '24px', borderRadius: '50%' }); headerRow.appendChild(img); }
        const info = document.createElement('div');
        info.innerHTML = `<span style="font-weight:bold;color:#eee;font-size:12px;">${msg.name || msg.author}</span><span style="color:#666;font-size:10px;margin-left:4px;">${msg.time}</span>`;
        headerRow.appendChild(info);
        row.appendChild(headerRow);

        // 文本 (更紧凑)
        const textDiv = document.createElement('div');
        textDiv.textContent = msg.text.substring(0, 50) + (msg.text.length > 50 ? '...' : '');
        textDiv.style.cssText = 'color:#ccc;font-size:11px;margin-bottom:6px;';
        row.appendChild(textDiv);

        // 规则匹配
        const textTarget = (msg.text + ' ' + (msg.originalText || '')).toLowerCase();
        const urlTarget = ((msg.currentUrl || '') + ' ' + (msg.originalUrl || '')).toLowerCase();
        const authorTarget = ((msg.author || '') + ' ' + (msg.originalAuthor || '')).toLowerCase();
        const matchedCoinRuleMap = new Map();
        const settings = getTradeSettings();
        const blacklist = settings.blacklist || [];

        matchRules.forEach(rule => {
            const key = rule.value.toLowerCase();
            const inText = textTarget.includes(key);
            const inUrl = urlTarget.includes(key);
            const inAuthor = authorTarget.includes(key);
            if (inText || inUrl || inAuthor) {
                // 匹配度评分：文本命中3分，URL命中2分，作者命中1分
                const matchScore = (inText ? 3 : 0) + (inUrl ? 2 : 0) + (inAuthor ? 1 : 0);
                matchedCoinRuleMap.set(rule.coin, { ...rule, matchScore });
            }
        });

        const nodeIndex = _memNodeIndex || GM_getValue(NODE_INDEX_KEY, null);
        if (nodeIndex) {
            Object.entries(nodeIndex).forEach(([keyword, coins]) => {
                const isShort = /^[a-z0-9]+$/i.test(keyword) && keyword.length <= 5;
                const inText = isShort ? new RegExp(`\\b${keyword}\\b`, 'i').test(textTarget) : textTarget.includes(keyword);
                const inUrl = urlTarget.includes(keyword);
                const inAuthor = authorTarget.includes(keyword);
                const hit = inText || inUrl || inAuthor;
                const matchScore = (inText ? 3 : 0) + (inUrl ? 2 : 0) + (inAuthor ? 1 : 0);
                if (hit) coins.forEach(coin => { if (!matchedCoinRuleMap.has(coin)) matchedCoinRuleMap.set(coin, { value: keyword, coin, color: '#ff6666', matchScore }); });
            });
        }

        // 从文本中提取0x开头的BSC CA地址，直接加入匹配
        const caRegex = /0x[a-fA-F0-9]{40}/g;
        const fullText = msg.text + ' ' + (msg.originalText || '') + ' ' + (msg.currentUrl || '') + ' ' + (msg.originalUrl || '');
        let caMatch;
        while ((caMatch = caRegex.exec(fullText)) !== null) {
            const ca = caMatch[0].toLowerCase();
            if (!matchedCoinRuleMap.has(ca)) {
                matchedCoinRuleMap.set(ca, { value: 'CA', coin: ca, color: '#1d9bf0', matchScore: 5 });
            }
        }

        // 黑名单过滤（完全匹配）
        const filteredRules = [];
        const displayRules = new Map();
        matchedCoinRuleMap.forEach((rule, coin) => {
            // 跳过非字符串的 coin（脏数据保护）
            if (typeof coin !== 'string') return;
            const ruleKey = rule.value.toLowerCase();
            const coinKey = coin.toLowerCase();
            // 完全匹配：规则关键词或CA地址完全等于黑名单中的某项
            if (blacklist.includes(ruleKey) || blacklist.includes(coinKey)) {
                filteredRules.push(rule.value);
            } else {
                displayRules.set(coin, rule);
            }
        });

        // 显示过滤提示
        if (filteredRules.length > 0) {
            const filterTip = document.createElement('div');
            filterTip.textContent = `⛔ 已过滤: ${filteredRules.join(', ')}`;
            filterTip.style.cssText = 'color:#666;font-size:10px;margin-bottom:4px;';
            row.appendChild(filterTip);
        }

        // 渲染匹配的 CA + 买入按钮 (按规则分组，币标注所有匹配规则)
        if (displayRules.size > 0) {
            // 1. 先收集每个CA匹配的所有规则
            const caToRulesMap = new Map(); // ca -> { rules: [], node: {} }
            // 2. 同时收集每个规则对应的CA列表
            const ruleToCoinsMap = new Map(); // ruleName -> [{ ca, node }]

            displayRules.forEach((rule, coin) => {
                const localResult = getRelatedNodesLocally(coin, rule.value);
                const nodes = (localResult.ok && localResult.nodes.length > 0) ? localResult.nodes : [{ ca: coin }];
                nodes.forEach(node => {
                    const caAddr = node.ca;
                    // 只显示0x开头的CA
                    if (!caAddr || !caAddr.startsWith('0x')) return;
                    // 记录CA对应的所有规则
                    if (!caToRulesMap.has(caAddr)) {
                        caToRulesMap.set(caAddr, { rules: [], node });
                    }
                    if (!caToRulesMap.get(caAddr).rules.includes(rule.value)) {
                        caToRulesMap.get(caAddr).rules.push(rule.value);
                    }
                    // 记录规则对应的所有CA
                    if (!ruleToCoinsMap.has(rule.value)) {
                        ruleToCoinsMap.set(rule.value, []);
                    }
                    const existing = ruleToCoinsMap.get(rule.value);
                    if (!existing.some(e => e.ca === caAddr)) {
                        existing.push({ ca: caAddr, node });
                    }
                });
            });

            // 按规则排序：匹配度高的优先
            // 优先级：1.完全匹配(keyword=ticket/symbol/CA) 2.matchScore(文本3>URL2>作者1) 3.关联CA数量
            const sortedRules = [...ruleToCoinsMap.entries()].sort((a, b) => {
                const aKeyword = a[0].toLowerCase();
                const bKeyword = b[0].toLowerCase();
                const aExact = a[1].some(c => {
                    const t = (c.node.ticket || '').toLowerCase();
                    const s = (c.node.symbol || '').toLowerCase();
                    const ca = (c.ca || '').toLowerCase();
                    return aKeyword === t || aKeyword === s || aKeyword === ca;
                });
                const bExact = b[1].some(c => {
                    const t = (c.node.ticket || '').toLowerCase();
                    const s = (c.node.symbol || '').toLowerCase();
                    const ca = (c.ca || '').toLowerCase();
                    return bKeyword === t || bKeyword === s || bKeyword === ca;
                });
                if (aExact && !bExact) return -1;
                if (!aExact && bExact) return 1;
                // 按 matchScore 排序（取该规则关联的最高分）
                const aScore = Math.max(...a[1].map(c => {
                    const rule = displayRules.get(c.ca) || matchedCoinRuleMap.get(c.ca);
                    return (rule && rule.matchScore) || 0;
                }));
                const bScore = Math.max(...b[1].map(c => {
                    const rule = displayRules.get(c.ca) || matchedCoinRuleMap.get(c.ca);
                    return (rule && rule.matchScore) || 0;
                }));
                if (aScore !== bScore) return bScore - aScore;
                return b[1].length - a[1].length;
            });

            // 合并币集合相同的规则为一组
            const mergedGroups = [];
            const usedRules = new Set();
            sortedRules.forEach(([ruleName, coins]) => {
                if (usedRules.has(ruleName)) return;
                const caSet = new Set(coins.map(c => c.ca));
                const group = { ruleNames: [ruleName], coins };
                usedRules.add(ruleName);
                sortedRules.forEach(([otherName, otherCoins]) => {
                    if (usedRules.has(otherName)) return;
                    const otherSet = new Set(otherCoins.map(c => c.ca));
                    if (otherSet.size === caSet.size && [...caSet].every(ca => otherSet.has(ca))) {
                        group.ruleNames.push(otherName);
                        usedRules.add(otherName);
                    }
                });
                mergedGroups.push(group);
            });

            const container = document.createElement('div');
            Object.assign(container.style, { display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '6px', position: 'relative' });

            mergedGroups.forEach(({ ruleNames, coins }) => {
                // 规则框
                const ruleBox = document.createElement('div');
                Object.assign(ruleBox.style, {
                    padding: '6px 8px',
                    background: 'rgba(255,153,0,0.08)',
                    border: '1px solid rgba(255,153,0,0.3)',
                    borderRadius: '6px'
                });

                // 规则标题（合并后的规则名）
                const ruleTitle = document.createElement('div');
                ruleTitle.textContent = ruleNames.join(' / ');
                Object.assign(ruleTitle.style, { color: '#f90', fontSize: '11px', fontWeight: 'bold', marginBottom: '4px' });
                ruleBox.appendChild(ruleTitle);

                // 币列表
                const coinList = document.createElement('div');
                Object.assign(coinList.style, { display: 'flex', flexWrap: 'wrap', gap: '4px' });

                const allSameRules = coins.every(({ ca: caAddr }) => {
                    const r = caToRulesMap.get(caAddr)?.rules || [];
                    return r.length === ruleNames.length && ruleNames.every(n => r.includes(n));
                });

                coins.forEach(({ ca: caAddr, node }) => {
                    const allRules = caToRulesMap.get(caAddr)?.rules || ruleNames;
                    let displayName = node.ticket || node.symbol || (caAddr.slice(0, 4) + '..' + caAddr.slice(-3));
                    const nodeColor = node.color || '#1d9bf0';

                    // 币按钮组
                    const coinItem = document.createElement('div');
                    coinItem.dataset.ca = caAddr;
                    const caRule = displayRules.get(caAddr) || matchedCoinRuleMap.get(caAddr);
                    coinItem.dataset.matchScore = caRule?.matchScore || 0;
                    Object.assign(coinItem.style, { display: 'inline-flex', alignItems: 'center', gap: '3px' });

                    // 只在该币匹配的规则与组标题不同时才显示额外标签
                    if (!allSameRules && allRules.length > 1) {
                        const extraRules = allRules.filter(r => !ruleNames.includes(r));
                        if (extraRules.length > 0) {
                            const multiTag = document.createElement('span');
                            multiTag.textContent = '+' + extraRules.join('/');
                            Object.assign(multiTag.style, { color: '#888', fontSize: '9px', maxWidth: '60px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' });
                            multiTag.title = allRules.join(' / ');
                            coinItem.appendChild(multiTag);
                        }
                    }

                    // [币名|买] 按钮
                    const btnGroup = document.createElement('div');
                    Object.assign(btnGroup.style, { display: 'inline-flex', borderRadius: '4px', overflow: 'hidden' });

                    const nameBtn = document.createElement('a');
                    nameBtn.href = `https://gmgn.ai/bsc/token/${caAddr}`;
                    nameBtn.target = '_blank';
                    nameBtn.title = caAddr;
                    nameBtn.textContent = displayName;
                    Object.assign(nameBtn.style, { padding: '2px 5px', background: '#444', color: '#fff', textDecoration: 'none', fontWeight: 'bold', cursor: 'pointer', fontSize: '10px' });

                    const buyBtn = document.createElement('button');
                    buyBtn.textContent = '买';
                    buyBtn.title = `${settings.defaultAmount} BNB`;
                    Object.assign(buyBtn.style, { padding: '2px 5px', background: '#2a5', color: '#fff', border: 'none', borderLeft: '1px solid rgba(0,0,0,0.2)', cursor: 'pointer', fontWeight: 'bold', fontSize: '10px' });
                    buyBtn.onmouseenter = () => buyBtn.style.background = '#3c7';
                    buyBtn.onmouseleave = () => buyBtn.style.background = '#2a5';
                    buyBtn.onclick = () => quickBuy(caAddr, getTradeSettings().defaultAmount);

                    btnGroup.appendChild(nameBtn);
                    btnGroup.appendChild(buyBtn);
                    coinItem.appendChild(btnGroup);
                    coinList.appendChild(coinItem);
                });

                ruleBox.appendChild(coinList);
                container.appendChild(ruleBox);
            });

            row.appendChild(container);

            // 右上角"↓mc"按钮：点击请求价格 + 渲染到ticket + 按市值排序
            const sortBtn = document.createElement('button');
            sortBtn.textContent = '↓mc';
            sortBtn.title = '请求价格并按市值排序';
            Object.assign(sortBtn.style, { position: 'absolute', top: '0', right: '0', padding: '1px 4px', fontSize: '8px', background: 'rgba(255,255,255,0.15)', color: '#ccc', border: '1px solid rgba(255,255,255,0.2)', borderRadius: '3px', cursor: 'pointer', zIndex: '1' });
            sortBtn.onclick = () => {
                sortBtn.textContent = '...';
                sortBtn.disabled = true;
                // 从DOM收集所有实际渲染的CA
                const realCAs = [...new Set([...container.querySelectorAll('[data-ca]')].map(el => el.dataset.ca.toLowerCase()))];
                if (realCAs.length === 0) { sortBtn.textContent = '↓mc'; sortBtn.disabled = false; return; }
                fetchPrices(realCAs, (priceMap) => {
                    // 价格渲染到ticket按钮内
                    container.querySelectorAll('[data-ca]').forEach(item => {
                        const data = priceMap[item.dataset.ca?.toLowerCase()];
                        if (!data) return;
                        const mc = formatMcap(data.marketCap);
                        const priceText = formatTokenPrice(data.price);
                        const metricText = mc || priceText;
                        if (!metricText) return;
                        const nameBtn = item.querySelector('a');
                        if (!nameBtn) return;
                        const origText = nameBtn.dataset.origText || nameBtn.textContent;
                        nameBtn.dataset.origText = origText;
                        const changeNum = parseFloat(data.priceChange1H || '0');
                        const hasChange = Number.isFinite(changeNum);
                        const changeSign = hasChange && changeNum >= 0 ? '+' : '';
                        const changeColor = changeNum >= 0 ? '#4caf50' : '#f44336';
                        const changeHtml = hasChange
                            ? ` <span style="font-size:8px;font-weight:normal;color:${changeColor};">${changeSign}${data.priceChange1H}%</span>`
                            : '';
                        nameBtn.innerHTML = `${origText} <span style="font-size:8px;font-weight:normal;">${metricText}</span>${changeHtml}`;
                    });
                    // 排序：完全匹配优先，再按市值降序
                    container.querySelectorAll('div[style*="flex-wrap"]').forEach(coinList => {
                        const items = [...coinList.querySelectorAll('[data-ca]')];
                        items.sort((a, b) => {
                            const aScore = parseInt(a.dataset.matchScore || '0');
                            const bScore = parseInt(b.dataset.matchScore || '0');
                            if (aScore !== bScore) return bScore - aScore;
                            const aMc = parseFloat(priceMap[a.dataset.ca?.toLowerCase()]?.marketCap || '0');
                            const bMc = parseFloat(priceMap[b.dataset.ca?.toLowerCase()]?.marketCap || '0');
                            return bMc - aMc;
                        });
                        items.forEach(item => coinList.appendChild(item));
                    });
                    sortBtn.textContent = '↓mc';
                    sortBtn.disabled = false;
                });
            };
            container.appendChild(sortBtn);
            // 渲染完自动触发
            sortBtn.click();
        }

        return row;
    }

    function addMessageToHistory(msgType, time, name, author, avatarUrl, text, currentUrl, originalUrl, originalText = '', isOriginal = false, tweetId = '', originalAuthor = '') {
        const tweetKey = tweetId || currentUrl || `${author}-${text.substring(0, 30)}`;
        const isUpdate = displayedTweetKeys.has(tweetKey);

        // 自动买入优先：不等渲染，立即检查（抢速度）
        if (msgType !== 'system') {
            checkAutoBuy(text, originalText, currentUrl, originalUrl, author, originalAuthor);
        }

        if (isUpdate) {
            const existingIdx = messageHistory.findIndex(m => (m.tweetId || m.currentUrl || `${m.author}-${m.text.substring(0, 30)}`) === tweetKey);
            if (existingIdx !== -1) {
                const updatedMsg = { time, type: msgType, name, author, avatarUrl, text, currentUrl, originalUrl, originalText, isOriginal, tweetId, originalAuthor };
                messageHistory[existingIdx] = updatedMsg;
                const oldRow = historyContent.children[existingIdx];
                if (oldRow) {
                    const newRow = renderMessage(updatedMsg);
                    historyContent.replaceChild(newRow, oldRow);
                }
                console.log(`[消息更新] 推文 ${tweetKey.slice(0, 20)} 已用更完整的数据更新`);
            }
            return;
        }

        displayedTweetKeys.add(tweetKey);
        if (messageHistory.length >= MAX_HISTORY) { const old = messageHistory.pop(); displayedTweetKeys.delete(old.tweetId || old.currentUrl || `${old.author}-${old.text.substring(0, 30)}`); }
        const msg = { time, type: msgType, name, author, avatarUrl, text, currentUrl, originalUrl, originalText, isOriginal, tweetId, originalAuthor };
        messageHistory.unshift(msg);
        const row = renderMessage(msg);
        historyContent.insertBefore(row, historyContent.firstChild);
        historyContent.scrollTop = 0;
        floatBox.style.display = 'flex';
        wakeBtn.style.display = 'none';
    }

    // ==================== WSS 连接 ====================
    // 不再需要主动连接外部 WSS，改为拦截 GMGN 自身的 WebSocket
    function connect() {
        console.log('[WSS] 使用 GMGN 原生 WebSocket 拦截模式，无需主动连接');
        addMessageToHistory('system', new Date().toLocaleTimeString([], { hour12: false }), '系统', 'System', '', '[WSS] 拦截器已就绪，等待 GMGN WebSocket 连接...', '', '', '', false, 'sys-' + Date.now());
    }

    // ==================== 推特账号管理面板 ====================
    function showTwitterManagePanel() {
        const panel = document.createElement('div');
        Object.assign(panel.style, { position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', width: '400px', maxHeight: '70vh', background: 'rgba(30,30,45,0.98)', border: '1px solid #555', borderRadius: '10px', padding: '16px', color: '#eee', zIndex: '999999', overflowY: 'auto' });

        panel.innerHTML = `
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
                <span style="color:#1d9bf0;font-weight:bold;font-size:15px;">📱 推特账号管理</span>
                <button id="close-twitter-panel" style="background:none;border:none;color:#888;font-size:18px;cursor:pointer;">×</button>
            </div>
            <div style="color:#aaa;font-size:11px;margin-bottom:10px;">管理常用推特账号，用于自动买入规则</div>
            <div style="display:flex;gap:6px;margin-bottom:10px;">
                <button id="refresh-twitter" style="padding:4px 10px;background:#1d9bf0;border:none;color:#fff;border-radius:4px;font-size:11px;cursor:pointer;">刷新</button>
            </div>
            <div id="twitter-list" style="margin-bottom:12px;max-height:200px;overflow-y:auto;"></div>
            <div style="display:flex;gap:6px;flex-wrap:wrap;">
                <input id="tw-username" placeholder="推特账号" style="flex:1;padding:5px;background:#1e1e2e;border:1px solid #444;color:#eee;border-radius:4px;font-size:11px;">
                <input id="tw-note" placeholder="备注(可选)" style="width:100px;padding:5px;background:#1e1e2e;border:1px solid #444;color:#eee;border-radius:4px;font-size:11px;">
                <button id="add-twitter" style="padding:5px 12px;background:#1d9bf0;border:none;color:#fff;border-radius:4px;font-size:11px;cursor:pointer;">添加</button>
            </div>
        `;

        document.body.appendChild(panel);

        async function renderTwitterList() {
            const list = panel.querySelector('#twitter-list');
            list.innerHTML = '<div style="color:#666;font-size:11px;text-align:center;padding:12px;">加载中...</div>';

            await loadTwitterUsersFromServer();
            const users = getTwitterUsers();

            if (users.length === 0) {
                list.innerHTML = '<div style="color:#666;font-size:11px;text-align:center;padding:12px;">暂无推特账号</div>';
                return;
            }

            list.innerHTML = users.map((u, i) => {
                const noteDisplay = u.note ? `<span style="color:#888;font-size:10px;margin-left:6px;">${u.note}</span>` : '';
                return `
                <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 8px;background:rgba(29,155,240,0.1);border:1px solid rgba(29,155,240,0.3);border-radius:4px;margin-bottom:4px;">
                    <div style="font-size:12px;">
                        <b style="color:#1d9bf0;">@${u.username}</b>
                        ${noteDisplay}
                    </div>
                    <button data-idx="${i}" class="del-twitter" style="background:#c44;border:none;color:#fff;padding:2px 6px;border-radius:3px;font-size:10px;cursor:pointer;">删</button>
                </div>
            `}).join('');

            // 绑定删除事件
            list.querySelectorAll('.del-twitter').forEach(btn => {
                btn.onclick = async () => {
                    const idx = parseInt(btn.dataset.idx);
                    if (!confirm(`确定删除 @${users[idx].username} 吗？`)) return;
                    btn.disabled = true;
                    btn.textContent = '...';
                    const result = await removeTwitterUserFromServer(idx);
                    if (result.success) {
                        renderTwitterList();
                    } else {
                        alert('删除失败: ' + (result.error || '未知错误'));
                        btn.disabled = false;
                        btn.textContent = '删';
                    }
                };
            });
        }

        renderTwitterList();

        // 刷新
        panel.querySelector('#refresh-twitter').onclick = async () => {
            await renderTwitterList();
        };

        // 添加账号
        panel.querySelector('#add-twitter').onclick = async () => {
            const username = panel.querySelector('#tw-username').value.trim();
            const note = panel.querySelector('#tw-note').value.trim();

            if (!username) {
                alert('请输入推特账号');
                return;
            }

            const btn = panel.querySelector('#add-twitter');
            btn.disabled = true;
            btn.textContent = '添加中...';

            const result = await addTwitterUserToServer(username, note);

            btn.disabled = false;
            btn.textContent = '添加';

            if (result.success) {
                panel.querySelector('#tw-username').value = '';
                panel.querySelector('#tw-note').value = '';
                renderTwitterList();
            } else {
                alert('添加失败: ' + (result.error || '未知错误'));
            }
        };

        panel.querySelector('#close-twitter-panel').onclick = () => panel.remove();
    }

    // ==================== 规则面板 ====================
    function showRulePanel() {
        const panel = document.createElement('div');
        Object.assign(panel.style, { position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', width: '480px', maxHeight: '80vh', background: 'rgba(30,30,45,0.98)', border: '1px solid #555', borderRadius: '10px', padding: '16px', color: '#eee', zIndex: '999999', overflowY: 'auto' });

        panel.innerHTML = `
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
                <span style="color:#0f0;font-weight:bold;font-size:16px;">规则管理</span>
                <button id="close-rule-panel" style="background:none;border:none;color:#888;font-size:20px;cursor:pointer;">×</button>
            </div>
            <div style="display:flex;gap:8px;margin-bottom:12px;">
                <input id="rule-value" placeholder="关键字" style="flex:1;padding:6px;background:#1e1e2e;border:1px solid #444;color:#eee;border-radius:4px;">
                <input id="rule-coin" placeholder="目标CA" style="flex:1;padding:6px;background:#1e1e2e;border:1px solid #444;color:#eee;border-radius:4px;">
                <button id="add-rule-btn" style="padding:6px 12px;background:#1d9bf0;border:none;color:#fff;border-radius:4px;cursor:pointer;">添加</button>
            </div>
            <div id="rule-list"></div>
        `;

        document.body.appendChild(panel);
        panel.querySelector('#close-rule-panel').onclick = () => panel.remove();

        const renderRules = () => {
            const list = panel.querySelector('#rule-list');
            list.innerHTML = matchRules.length === 0 ? '<div style="color:#666;text-align:center;padding:20px;">暂无规则</div>' : '';
            matchRules.forEach((rule, idx) => {
                const item = document.createElement('div');
                Object.assign(item.style, { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px', background: 'rgba(50,50,70,0.3)', borderRadius: '6px', marginBottom: '6px' });
                item.innerHTML = `<span><b>${rule.value}</b> → <a href="https://gmgn.ai/bsc/token/${rule.coin}" target="_blank" style="color:#1d9bf0;">${rule.coin.slice(0, 8)}...</a></span>`;
                const delBtn = document.createElement('button');
                delBtn.textContent = '删除';
                Object.assign(delBtn.style, { background: '#c00', border: 'none', color: '#fff', padding: '3px 8px', borderRadius: '4px', cursor: 'pointer', fontSize: '11px' });
                delBtn.onclick = async () => { await removeRuleFromServer(idx); renderRules(); };
                item.appendChild(delBtn);
                list.appendChild(item);
            });
        };

        panel.querySelector('#add-rule-btn').onclick = async () => {
            const value = panel.querySelector('#rule-value').value.trim();
            const coin = panel.querySelector('#rule-coin').value.trim();
            if (!value || !coin) return alert('请填写完整');
            await addRuleToServer({ value, coin, color: '#ff4444' });
            panel.querySelector('#rule-value').value = '';
            panel.querySelector('#rule-coin').value = '';
            renderRules();
        };

        renderRules();
    }

    // ==================== 启动 ====================
    // WebSocket 拦截器已在脚本开头初始化（document-start 阶段）
    // UI 初始化需要等待 DOM 加载完成
    function initializeUI() {
        console.log('[WSS] 初始化 UI...');

        // 初始化 UI
        createWakeButton();
        createFloatingBox();

        // 重置浮动框功能
        function resetFloatUI(resetPosition = false) {
            console.log('[WSS] 重置浮动框...');

            // 如果需要重置位置，清除保存的状态
            if (resetPosition) {
                localStorage.removeItem('wss-box-state');
            }

            // 重新创建唤出按钮
            createWakeButton();

            // 重新创建主浮动框
            createFloatingBox();

            // 更新钱包选择器
            updateWalletSelector();

            // 显示浮动框
            floatBox.style.display = 'flex';
            wakeBtn.style.display = 'none';

            console.log('[WSS] 浮动框已重置');
            showTradeStatus('✅ 浮动框已重置', 'success');
        }

        // 检查浮动框是否存在，不存在则重建
        function checkAndRestoreUI() {
            const boxExists = document.getElementById('wss-float');
            const btnExists = document.getElementById('wss-wake-btn');

            if (!boxExists && !btnExists) {
                console.log('[WSS] 检测到浮动框丢失，正在恢复...');
                createWakeButton();
                createFloatingBox();
                updateWalletSelector();
                // 默认显示唤出按钮
                floatBox.style.display = 'none';
                wakeBtn.style.display = 'flex';
            } else if (!boxExists) {
                console.log('[WSS] 检测到主浮动框丢失，正在恢复...');
                createFloatingBox();
                updateWalletSelector();
            } else if (!btnExists) {
                console.log('[WSS] 检测到唤出按钮丢失，正在恢复...');
                createWakeButton();
            }
        }

        // 定期检查 UI 是否存在（每 5 秒）
        setInterval(checkAndRestoreUI, 5000);

        // 注册油猴菜单命令
        if (typeof GM_registerMenuCommand !== 'undefined') {
            GM_registerMenuCommand('🔄 重置浮动框', () => resetFloatUI(false), 'r');
            GM_registerMenuCommand('📍 重置浮动框位置', () => resetFloatUI(true), 'p');
            GM_registerMenuCommand('👁️ 显示浮动框', () => {
                if (floatBox) {
                    floatBox.style.display = 'flex';
                    if (wakeBtn) wakeBtn.style.display = 'none';
                }
            }, 's');
        }

        loadRulesFromServer();
        loadAutoBuyRulesFromServer();  // 加载自动买入规则
        loadTwitterUsersFromServer();  // 加载推特账号列表
        connect();
        startFullSync();
        tradeWS.connect();
        updateWalletSelector(); // 初始化钱包选择器

        window.wssFloat = {
            show: () => { floatBox.style.display = 'flex'; wakeBtn.style.display = 'none'; },
            hide: () => { floatBox.style.display = 'none'; wakeBtn.style.display = 'flex'; },
            clear: () => { messageHistory = []; displayedTweetKeys.clear(); historyContent.innerHTML = ''; },
            rules: showRulePanel,
            autobuy: showAutoBuyPanel,
            buy: quickBuy,
            wallets: updateWalletSelector,
            reloadAutoBuy: loadAutoBuyRulesFromServer,
            reset: () => resetFloatUI(false),
            resetPosition: () => resetFloatUI(true)
        };

        console.log('%c[WSS 监控 + 快捷买入 v5.0] 已加载 - GMGN 原生 WebSocket 拦截', 'color:#0f0;font-weight:bold;');
        console.log('命令: wssFloat.show() / hide() / clear() / rules() / autobuy() / buy(ca, amount) / wallets() / reloadAutoBuy() / reset() / resetPosition()');
        console.log('油猴菜单: 点击油猴图标可重置浮动框');
    }

    // 等待 DOM 加载完成后初始化 UI
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initializeUI);
    } else {
        // DOM 已经加载完成
        initializeUI();
    }

})();
