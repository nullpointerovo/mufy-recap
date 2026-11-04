// ==UserScript==
// @name         Mufy 年度报告与单点查询
// @namespace    http://tampermonkey.net/
// @version      25.8
// @description  不知道改成什么 一切问题请在xhs nullpointer找我
// @author       Nullpointer与Deepseek
// @match        https://*.mufy.ai/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const API_BASE = 'https://chat.mufy.ai';
    const STORAGE_MY_ID_KEY = 'mufy_my_user_id_auto';
    const CACHE_DATA_KEY = 'mufy_annual_report_cache_v25';
    const MAX_RENDER_COUNT = 1000;

    let capturedAuth = '';
    let autoDetectedId = '';

    // ============================================================
    // 1. 鉴权与自动身份拦截
    // ============================================================
    function isMyProfileUrl(url) {
        try {
            const u = new URL(url, location.origin);
            return ['/api/users/profile', '/api/user/profile', '/api/user/info', '/api/users/me'].includes(u.pathname);
        } catch (e) { return false; }
    }

    (function installAuthCapture() {
        try {
            const XHR = window.XMLHttpRequest;
            if (XHR && !XHR.prototype.__mufyHook) {
                XHR.prototype.__mufyHook = true;
                const origOpen = XHR.prototype.open;
                const origSetHeader = XHR.prototype.setRequestHeader;
                const origSend = XHR.prototype.send;

                XHR.prototype.open = function (method, url, ...rest) {
                    this.__mufyUrl = String(url || '');
                    return origOpen.call(this, method, url, ...rest);
                };
                XHR.prototype.setRequestHeader = function (name, value) {
                    if (/^authorization$/i.test(String(name)) && /(?:^|\/)api(?:\/|$)/i.test(this.__mufyUrl || '')) {
                        const v = String(value || '');
                        if (/^Bearer\s+\S+/i.test(v)) capturedAuth = v;
                    }
                    return origSetHeader.call(this, name, value);
                };
                XHR.prototype.send = function (...args) {
                    this.addEventListener('load', function() {
                        try {
                            if (this.__mufyUrl && isMyProfileUrl(this.__mufyUrl)) {
                                const res = JSON.parse(this.responseText);
                                const d = res?.data?.data || res?.data || res;
                                if (d && (d.id || d.userId) && (d.username || d.email || d.nickname || d.nickName)) {
                                    autoDetectedId = String(d.id || d.userId);
                                }
                            }
                        } catch(e) {}
                    });
                    return origSend.apply(this, args);
                };
            }
        } catch (_) {}

        try {
            const origFetch = window.fetch;
            if (typeof origFetch === 'function' && !origFetch.__mufyHook) {
                const wrapped = function (input, init) {
                    const url = typeof input === 'string' ? input : (input && input.url) || '';
                    try {
                        if (/(?:^|\/)api(?:\/|$)/i.test(url)) {
                            const headers = (init && init.headers) || (input && input.headers);
                            if (headers instanceof Headers) {
                                const auth = headers.get('Authorization') || headers.get('authorization');
                                if (auth) capturedAuth = auth;
                            } else if (headers && typeof headers === 'object' && !Array.isArray(headers)) {
                                for (const k of Object.keys(headers)) {
                                    if (/^authorization$/i.test(k)) capturedAuth = headers[k];
                                }
                            }
                        }
                    } catch (_) {}
                    const fetchPromise = origFetch.apply(this, arguments);
                    if (isMyProfileUrl(url)) {
                        try {
                            fetchPromise.then(res => {
                                const clone = res.clone();
                                clone.json().then(data => {
                                    const d = data?.data?.data || data?.data || data;
                                    if (d && (d.id || d.userId) && (d.username || d.email || d.nickname || d.nickName)) {
                                        autoDetectedId = String(d.id || d.userId);
                                    }
                                }).catch(()=>{});
                            }).catch(()=>{});
                        } catch(e) {}
                    }
                    return fetchPromise;
                };
                wrapped.__mufyHook = true;
                window.fetch = wrapped;
            }
        } catch (_) {}
    })();

    function getAuthorization() {
        if (capturedAuth) return capturedAuth;
        const local = localStorage.getItem('mufy-token') || localStorage.getItem('token') || localStorage.getItem('mufy_token');
        return local ? (/^Bearer\s+/i.test(local) ? local : `Bearer ${local}`) : '';
    }

    async function getMyUserId(onProgress) {
        let tokenId = '';
        const auth = getAuthorization();
        const token = auth.replace(/^Bearer\s+/i, '');
        if (token && token.split('.').length === 3) {
            try {
                const base64Url = token.split('.')[1];
                const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
                const jsonPayload = decodeURIComponent(atob(base64).split('').map(c =>
                    '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)
                ).join(''));
                const payload = JSON.parse(jsonPayload);
                tokenId = String(payload.userId || payload.id || payload.uid || payload.user_id || payload.sub || '');
            } catch (e) {}
        }

        const savedId = localStorage.getItem(STORAGE_MY_ID_KEY);

        if (tokenId && savedId && tokenId !== savedId) {
            localStorage.removeItem(STORAGE_MY_ID_KEY);
            localStorage.removeItem(CACHE_DATA_KEY);
            return tokenId;
        }

        if (tokenId) return tokenId;
        if (savedId) return savedId;
        if (autoDetectedId) return autoDetectedId;

        const scanStorage = (storage) => {
            for (let i = 0; i < storage.length; i++) {
                const key = storage.key(i);
                const val = storage.getItem(key);
                if (!val) continue;
                if (val.includes('userId') || val.includes('user_id')) {
                    try {
                        const obj = JSON.parse(val);
                        const id = obj.userId || obj.user_id || obj.id || (obj.user && obj.user.id) || (obj.state && obj.state.user && obj.state.user.id);
                        if (id && String(id).length > 20 && String(id).includes('-')) return String(id);
                    } catch(e) {}
                }
            }
            return null;
        };
        const localId = scanStorage(localStorage) || scanStorage(sessionStorage);
        if (localId) return localId;

        onProgress?.('正在询问服务器获取你的ID...');
        const apis = ['/api/users/profile', '/api/user/info', '/api/users/me', '/api/user/profile'];
        for (const api of apis) {
            try {
                const res = await fetch(`${API_BASE}${api}`, {
                    headers: { 'Authorization': getAuthorization() },
                    credentials: 'include'
                });
                if (res.ok) {
                    const data = await res.json();
                    const d = data?.data?.data || data?.data || data;
                    if (d && (d.id || d.userId)) return String(d.id || d.userId);
                }
            } catch (e) {}
        }
        return '';
    }

    async function mufyPost(url, data, retry = 2) {
        const headers = {
            'Accept': 'application/json, text/plain, */*',
            'Content-Type': 'application/json',
            'Origin': 'https://chat.mufy.ai',
            'Referer': 'https://chat.mufy.ai/'
        };
        const auth = getAuthorization();
        if (auth) headers.Authorization = auth;
        for (let i = 0; i < retry; i++) {
            try {
                const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(data), credentials: 'include' });
                if (res.status === 429) { await sleep(3000); continue; }

                let resData = null;
                try { resData = await res.json(); } catch(e) {}

                if (resData && resData.error === 'share_link_expired') {
                    const err = new Error('share_link_expired');
                    err.isExpired = true;
                    throw err;
                }
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                return resData;
            } catch (e) {
                if (e.isExpired) throw e;
                if (i === retry - 1) throw new Error(e.name === 'TypeError' ? '网络被拦截/跨域' : e.message);
                await sleep(1000);
            }
        }
    }

    async function mufyGet(url, retry = 2) {
        const headers = {
            'Accept': 'application/json',
            'Referer': 'https://chat.mufy.ai/'
        };
        const auth = getAuthorization();
        if (auth) headers.Authorization = auth;
        for (let i = 0; i < retry; i++) {
            try {
                const res = await fetch(url, { headers, credentials: 'include' });
                if (res.status === 429) { await sleep(3000); continue; }

                let resData = null;
                try { resData = await res.json(); } catch(e) {}

                if (resData && resData.error === 'share_link_expired') {
                    const err = new Error('share_link_expired');
                    err.isExpired = true;
                    throw err;
                }
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                return resData;
            } catch (e) {
                if (e.isExpired) throw e;
                if (i === retry - 1) throw new Error(e.name === 'TypeError' ? '网络被拦截/跨域' : e.message);
                await sleep(1000);
            }
        }
    }

    function pick(obj, ...paths) {
        for (const path of paths) {
            const v = path.split('.').reduce((o, key) => (o == null ? undefined : o[key]), obj);
            if (v != null && v !== '') return v;
        }
        return undefined;
    }

    const state = { loading: false, roles: [], authors: [], activeTab: 'role', myUserId: '', searchQuery: '', isScanning: false, expandedAuthors: new Set() };

    // ============================================================
    // 2. 本地缓存
    // ============================================================
    function saveCache() {
        const cacheData = {
            roles: state.roles, authors: state.authors, myUserId: state.myUserId, time: new Date().toLocaleString('zh-CN')
        };
        localStorage.setItem(CACHE_DATA_KEY, JSON.stringify(cacheData));
    }

    function loadCache() {
        try {
            const data = JSON.parse(localStorage.getItem(CACHE_DATA_KEY) || 'null');
            if (data && data.roles && data.roles.length > 0) {
                if (data.myUserId && state.myUserId && data.myUserId !== state.myUserId) return null;
                state.roles = data.roles;
                state.authors = data.authors;
                state.myUserId = data.myUserId;
                return data.time;
            }
        } catch(e) {}
        return null;
    }

    // ============================================================
    // 3. 核心抓取逻辑
    // ============================================================
    async function fetchAllCharacters(onProgress) {
        const roleMap = new Map();
        for (const isFollowed of [false, true]) {
            let page = 1, hasNext = true;
            while (hasNext && page <= 100) {
                onProgress?.(`读取列表第 ${page} 页...`);
                const url = `${API_BASE}/api/characters/query_session?pageNum=${page}&pageSize=20&isFollowed=${isFollowed}`;
                let res;
                try { res = await mufyGet(url); } catch (e) {
                    throw new Error(`抓取列表失败: ${e.message}`);
                }

                const rows = Array.isArray(res?.data?.data) ? res.data.data : [];
                rows.forEach(item => {
                    const cid = pick(item, 'characterId', 'id');
                    if (!cid) return;

                    const charObj = item.character || item.characterInfo || {};
                    const authorObj = item.author || item.creator || item.user || charObj.author || charObj.creator || {};

                    const aId = pick(item, 'authorId', 'creatorId', 'userId', 'ownerId')
                             || pick(charObj, 'authorId', 'creatorId', 'userId')
                             || pick(authorObj, 'id', 'userId') || '';

                    roleMap.set(cid, {
                        characterId: cid,
                        name: pick(item, 'name', 'characterName', 'title') || pick(charObj, 'name') || '未命名',
                        authorId: aId,
                        authorName: pick(item, 'authorName', 'creatorName') || pick(authorObj, 'name', 'username', 'nickname') || '',
                        rounds: 0,
                        hasCommented: false,
                        isScanning: false,
                        hasScanned: false,
                        isExpired: false
                    });
                });
                hasNext = Boolean(res?.data?.hasNext) && rows.length > 0;
                page++;
                await sleep(150);
            }
        }
        return [...roleMap.values()];
    }

    function isSameId(id1, id2) {
        if (!id1 || !id2) return false;
        const clean = (str) => String(str).replace(/[-\s]/g, '').toLowerCase();
        return clean(id1) === clean(id2);
    }

    function walkCommentTree(list, visitor, seen = new Set()) {
        if (!Array.isArray(list)) return;
        for (const comment of list) {
            if (!comment || typeof comment !== 'object' || seen.has(comment)) continue;
            seen.add(comment);
            visitor(comment);
            const children = comment.subComments || comment.sub_comments || comment.replies || comment.children;
            if (Array.isArray(children)) walkCommentTree(children, visitor, seen);
        }
    }

    async function fetchMyRoundsFromComments(characterId, myUserId) {
        if (!myUserId) return { rounds: 0, hasCommented: false, isExpired: false };

        let myRounds = 0;
        let hasCommented = false;
        let isExpired = false;
        const seenCommentIds = new Set();

        const processComment = (comment) => {
            const commentId = pick(comment, 'id', 'commentId');
            if (commentId && seenCommentIds.has(String(commentId))) return;
            if (commentId) seenCommentIds.add(String(commentId));

            const commenterId = pick(comment, 'commentatorId', 'userId', 'authorId', 'creatorId', 'commentator.id', 'commentator.userId', 'user.id', 'author.id', 'creator.id');

            if (!isSameId(commenterId, myUserId)) return;
            hasCommented = true;
            const value = Number(pick(comment, 'interactionRounds', 'rounds') || 0);
            if (Number.isFinite(value) && value > myRounds) myRounds = value;
        };

        try {
            const url = `${API_BASE}/api/comments/list`;
            const payload = { characterId, sortBy: "latest", pageNum: 1, pageSize: 10 };
            const res = await mufyPost(url, payload, 1);

            if (res?.code === 200 && Array.isArray(res?.data?.data)) {
                const comments = res.data.data;
                walkCommentTree(comments, processComment);

                if (myRounds > 0) return { rounds: myRounds, hasCommented: true, isExpired: false };

                if (hasCommented) {
                    const target = comments.find(c => isSameId(pick(c, 'commentatorId', 'userId'), myUserId));
                    if (target && target.replyCount > 0) {
                        const rUrl = `${API_BASE}/api/comments/list?parentId=${target.id}&pageNum=1&pageSize=50`;
                        const rRes = await mufyGet(rUrl, 1);
                        if (rRes && rRes.data) {
                            const rList = Array.isArray(rRes.data) ? rRes.data : (rRes.data.data || []);
                            walkCommentTree(rList, processComment);
                            if (myRounds > 0) return { rounds: myRounds, hasCommented: true, isExpired: false };
                        }
                    }
                }
            } else {
                isExpired = true;
            }
        } catch(e) {
            if (e.isExpired) isExpired = true;
        }

        let page = 1;
        let hasNext = true;

        while (hasNext && page <= 50 && !isExpired) {
            const url = `${API_BASE}/api/comments/list`;
            const payload = { characterId, sortBy: "heat", pageNum: page, pageSize: 10 };

            let res;
            try { res = await mufyPost(url, payload); } catch (e) {
                if (e.isExpired) isExpired = true;
                break;
            }

            const comments = Array.isArray(res?.data?.data) ? res.data.data : [];
            walkCommentTree(comments, processComment);

            if (myRounds > 0) break;

            if (hasCommented && myRounds === 0) {
                const myComment = comments.find(c => isSameId(pick(c, 'commentatorId', 'userId'), myUserId));
                if (myComment && myComment.replyCount > 0) {
                    const rUrl = `${API_BASE}/api/comments/list?parentId=${myComment.id}&pageNum=1&pageSize=50`;
                    try {
                        const rRes = await mufyGet(rUrl);
                        if (rRes && rRes.data) {
                            const rList = Array.isArray(rRes.data) ? rRes.data : (rRes.data.data || []);
                            walkCommentTree(rList, processComment);
                            if (myRounds > 0) break;
                        }
                    } catch(e) {}
                }
            }

            hasNext = Boolean(res?.data?.hasNext) && comments.length > 0;
            page++;
            await sleep(200);
        }
        return { rounds: myRounds, hasCommented, isExpired };
    }

    async function streamScanRoles(roles, myUserId, onProgress, onItemUpdate) {
        if (!myUserId) return;

        const CONCURRENCY = 2;
        let index = 0;
        let completedCount = 0;

        async function worker() {
            while (index < roles.length) {
                const currentIndex = index++;
                const role = roles[currentIndex];

                role.isScanning = true;
                onItemUpdate();

                const result = await fetchMyRoundsFromComments(role.characterId, myUserId);

                role.rounds = result.rounds;
                role.hasCommented = result.hasCommented;
                if (result.isExpired) role.isExpired = true;
                role.isScanning = false;
                role.hasScanned = true;
                completedCount++;

                onProgress(completedCount, roles.length);
                onItemUpdate();

                await sleep(150);
            }
        }

        const workers = Array.from({ length: CONCURRENCY }, worker);
        await Promise.all(workers);
    }

    async function streamScanAuthors(authors, onProgress, onItemUpdate) {
        const CONCURRENCY = 2;
        let index = 0;
        let completedCount = 0;

        async function worker() {
            while (index < authors.length) {
                const currentIndex = index++;
                const author = authors[currentIndex];

                author.isScanning = true;
                onItemUpdate();

                if (author.id !== 'unknown') {
                    try {
                        const res = await mufyGet(`${API_BASE}/api/users/profiles?userId=${encodeURIComponent(author.id)}`);
                        if (res.code === 200) {
                            const d = res.data?.data || res.data || res;
                            const newName = pick(d, 'username', 'nickname', 'name');
                            if (newName) {
                                author.name = newName;
                                state.roles.forEach(r => {
                                    if (r.authorId === author.id) r.authorName = newName;
                                });
                            }
                            author.avatarUrl = pick(d, 'avatarUrl', 'avatar', 'commentatorAvatarUrl') || author.avatarUrl;
                            author.totalRounds = Number(pick(d, 'totalChatRounds') || 0);
                            author.cards = Number(pick(d, 'createdCharacterCount') || 0);
                            author.level = Number(pick(d, 'creatorLevel') || 0);
                        }
                    } catch(e) {
                        console.warn(e);
                    }
                }

                author.hasScanned = true;
                author.isScanning = false;
                completedCount++;

                onProgress(completedCount, authors.length);
                onItemUpdate();

                await sleep(150);
            }
        }

        const workers = Array.from({ length: CONCURRENCY }, worker);
        await Promise.all(workers);
    }

    // ============================================================
    // 4. 榜单生成与 UI 渲染
    // ============================================================
    function esc(v) { return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

    function renderContent(contentEl) {
        const isAuthor = state.activeTab === 'author';
        let data = isAuthor ? state.authors : state.roles;

        if (!state.isScanning && state.searchQuery) {
            const q = state.searchQuery.toLowerCase();
            data = data.filter(item => {
                if (isAuthor) return item.name.toLowerCase().includes(q) || String(item.id).toLowerCase().includes(q);
                return item.name.toLowerCase().includes(q) || String(item.characterId).toLowerCase().includes(q) || String(item.authorName).toLowerCase().includes(q);
            });
        }

        if (!data.length) {
            contentEl.innerHTML = `<div class="mufy-empty">${state.searchQuery ? '没有找到匹配的条目' : '暂无数据'}</div>`;
            return;
        }

        contentEl.innerHTML = data.slice(0, MAX_RENDER_COUNT).map((item, index) => {
            const rank = state.isScanning ? `#${index + 1}` : (index < 3 ? `0${index + 1}` : `#${index + 1}`);
            const isTop = index === 0 && !state.isScanning;

            if (isAuthor) {
                const subParts = [];
                if (item.isScanning) {
                    subParts.push(`<span style="color:#00e5ff;">读取中...</span>`);
                } else if (!item.hasScanned) {
                    subParts.push(`<span style="color:#666;">排队中...</span>`);
                } else {
                    if (item.id === 'unknown') {
                        subParts.push(`<span style="color:#ff5252;">已失效的赛博亡魂</span>`);
                    } else {
                        if (item.level > 0) subParts.push(`等级 ${item.level}`);
                        if (item.cards > 0) subParts.push(`主页卡数 ${item.cards}`);
                        subParts.push(`<span class="mufy-hl">你聊过 TA 的 ${item.rolesCount} 个角色</span>`);
                    }
                }

                const isExpanded = state.expandedAuthors.has(item.id);

                let subListHtml = '';
                if (isExpanded) {
                    const subRoles = state.roles.filter(r => (r.authorId || 'unknown') === item.id);
                    const sortedSubRoles = [...subRoles].sort((a,b) => (b.rounds || 0) - (a.rounds || 0));

                    const exploreBtn = `
                        <div class="mufy-explore-wrap">
                            <a href="https://chat.mufy.ai/profile/role?id=${item.id}" target="_blank" class="mufy-explore-btn ${state.isScanning ? 'mufy-disabled' : ''}">
                                去看看 TA 主页还有哪些卡 ↗
                            </a>
                        </div>
                    `;

                    if (sortedSubRoles.length > 0) {
                        subListHtml = `
                            <div class="mufy-sub-list">
                                ${sortedSubRoles.map(r => {
                                    let statusText = '';
                                    if (r.isScanning) statusText = '读取中...';
                                    else if (!r.hasScanned) statusText = '排队中';
                                    else if (r.rounds > 0) statusText = `${r.rounds} 轮`;
                                    else if (r.isExpired) statusText = '你两见过，没嫖过，你也嫖不了了';
                                    else statusText = '未评论';

                                    return `
                                    <a href="https://chat.mufy.ai/chat?roleId=${r.characterId}" target="_blank" class="mufy-sub-item ${state.isScanning ? 'mufy-disabled' : ''}">
                                        <div class="mufy-sub-name">— ${esc(r.name)}</div>
                                        <div class="mufy-sub-rounds ${r.rounds > 0 ? 'has-rounds' : (r.isExpired ? 'is-dead' : '')}">
                                            ${statusText}
                                        </div>
                                    </a>
                                `}).join('')}
                                ${item.id !== 'unknown' ? exploreBtn : ''}
                            </div>
                        `;
                    } else {
                        subListHtml = `
                            <div class="mufy-sub-list">
                                <div class="mufy-sub-empty">暂无可展示的卡</div>
                                ${item.id !== 'unknown' ? exploreBtn : ''}
                            </div>
                        `;
                    }
                }

                let statusText = '';
                let statusClass = '';
                if (item.isScanning) {
                    statusText = '读取中...';
                    statusClass = 'is-loading';
                } else if (!item.hasScanned) {
                    statusText = '排队中';
                    statusClass = 'is-pending';
                } else {
                    statusText = item.totalRounds > 0 ? `${item.totalRounds}` : '-';
                    statusClass = item.totalRounds > 0 ? 'is-done' : 'is-empty';
                }

                return `
                  <div class="mufy-row-wrap">
                    <div class="mufy-row mufy-author-toggle ${isTop ? 'is-top' : ''}" data-id="${item.id}">
                      <div class="mufy-row-left">
                        <span class="mufy-rank">${rank}</span>
                        <div class="mufy-avatar-wrap">
                            ${item.avatarUrl ? `<img src="${esc(item.avatarUrl)}" class="mufy-avatar">` : `<div class="mufy-avatar-placeholder"></div>`}
                        </div>
                        <div class="mufy-info">
                          <div class="mufy-name">${esc(item.name)} ${isExpanded ? '▴' : '▾'}</div>
                          <div class="mufy-sub-text">${subParts.join(' · ')}</div>
                        </div>
                      </div>
                      <div class="mufy-row-right">
                        <span class="mufy-score ${statusClass}">${statusText}</span>
                        <span class="mufy-score-unit">${item.totalRounds > 0 || item.isScanning || !item.hasScanned ? '轮' : ''}</span>
                      </div>
                    </div>
                    ${subListHtml}
                  </div>`;
            }

            let statusText = '';
            let statusClass = '';
            let authorText = item.authorName || '未知作者';

            if (item.isScanning) {
                statusText = '读取中...';
                statusClass = 'is-loading';
            } else if (item.rounds > 0) {
                statusText = `${item.rounds}`;
                statusClass = 'is-done';
            } else if (!state.myUserId) {
                statusText = '缺账号信息';
                statusClass = 'is-err';
            } else if (!item.hasScanned) {
                statusText = '排队中';
                statusClass = 'is-pending';
            } else if (item.isExpired && item.rounds === 0) {
                statusText = '未遂';
                statusClass = 'is-err';
                authorText = '你两见过，没嫖过，你也嫖不了了';
            } else if (item.hasCommented) {
                statusText = '无轮数';
                statusClass = 'is-empty';
            } else {
                statusText = '未评论';
                statusClass = 'is-empty';
            }

            return `
              <a href="https://chat.mufy.ai/chat?roleId=${item.characterId}" target="_blank" class="mufy-row-wrap mufy-link ${state.isScanning ? 'mufy-disabled' : ''}">
                <div class="mufy-row ${isTop ? 'is-top' : ''}">
                  <div class="mufy-row-left">
                    <span class="mufy-rank">${rank}</span>
                    <div class="mufy-info">
                      <div class="mufy-name">${esc(item.name)}</div>
                      <div class="mufy-sub-text ${item.isExpired && item.rounds === 0 ? 'text-danger' : ''}">${esc(authorText)}</div>
                    </div>
                  </div>
                  <div class="mufy-row-right">
                    <span class="mufy-score ${statusClass}">${statusText}</span>
                    <span class="mufy-score-unit">${item.rounds > 0 ? '轮' : ''}</span>
                    <span class="mufy-goto">↗</span>
                  </div>
                </div>
              </a>`;
        }).join('');

        if (data.length > MAX_RENDER_COUNT) {
            contentEl.innerHTML += `
                <div style="text-align: center; color: #666; padding: 20px; font-size: 12px;">
                    仅展示了前 ${MAX_RENDER_COUNT} 条数据，共有 ${data.length} 条。请使用上方的搜索框查找具体角色。
                </div>
            `;
        }
    }

    // ============================================================
    // 5. UI 挂载与 CSS 注入
    // ============================================================
    function mount() {
        if (document.getElementById('mufy-ar-root')) return;
        const style = document.createElement('style');
        style.textContent = `
          :root {
            --bg-main: #050505; --bg-card: #121212; --bg-hover: #1e1e1e;
            --bg-sub: #0a0a0a; --text-main: #ededed; --text-sub: #888888;
            --text-dark: #555555; --border-color: #222222; --accent: #ffffff;
          }
          #mufy-ar-btn { position: fixed; z-index: 2147483647 !important; width: 52px; height: 52px; background: #111; color: #fff; border: 1px solid var(--border-color); border-radius: 50%; cursor: pointer; font-size: 24px; box-shadow: 0 10px 30px rgba(0,0,0,0.8); transition: all 0.3s ease; display: flex; align-items: center; justify-content: center; pointer-events: auto !important; touch-action: manipulation !important; }
          #mufy-ar-btn:active { transform: scale(0.95); }
          #mufy-ar-modal { display: none; position: fixed; z-index: 2147483646 !important; background: rgba(10,10,10,0.95); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px); color: var(--text-main); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; flex-direction: column; box-shadow: 0 20px 60px rgba(0,0,0,0.9); }
          @media (min-width: 769px) { #mufy-ar-modal { top: 50%; left: 50%; transform: translate(-50%, -50%); width: 680px; max-height: 85vh; border-radius: 20px; border: 1px solid var(--border-color); } #mufy-ar-btn { bottom: 40px; right: 30px; } }
          @media (max-width: 768px) { #mufy-ar-modal { top: 50%; left: 50%; transform: translate(-50%, -50%); width: calc(100vw - 24px); height: 80vh; max-height: 800px; border-radius: 16px; border: 1px solid var(--border-color); } #mufy-ar-btn { bottom: 100px; right: 16px; width: 48px; height: 48px; font-size: 20px; } }

          .mufy-header { padding: 20px 20px 12px; display: flex; justify-content: space-between; align-items: flex-start; }
          .mufy-header h2 { margin: 0; font-size: 18px; font-weight: 500; letter-spacing: 1px; color: #fff; }
          .mufy-header p { margin: 4px 0 0; font-size: 12px; color: var(--text-sub); letter-spacing: 0.5px; }

          .mufy-close { background: transparent; border: none; color: var(--text-sub); font-size: 24px; cursor: pointer; padding: 0; line-height: 1; transition: color 0.2s; }
          .mufy-close:active { color: #fff; }

          .mufy-tools { padding: 0 20px 12px; display: flex; flex-direction: column; gap: 10px; }
          .mufy-search-box { display: flex; background: var(--bg-card); border: 1px solid var(--border-color); border-radius: 10px; padding: 2px; transition: border 0.3s; }
          .mufy-search-box:focus-within { border-color: #555; }
          .mufy-input { flex: 1; background: transparent; border: none; padding: 10px 12px; color: #fff; font-size: 13px; outline: none; }
          .mufy-input::placeholder { color: var(--text-dark); }

          .mufy-btn { background: #fff; color: #000; border: none; border-radius: 8px; padding: 0 16px; font-size: 13px; font-weight: 600; cursor: pointer; transition: all 0.2s; }
          .mufy-btn:active { background: #ccc; }
          .mufy-btn:disabled { background: #333; color: #666; cursor: not-allowed; }

          .mufy-status { font-size: 12px; color: #ff5252; padding: 0 4px; font-variant-numeric: tabular-nums; line-height: 1.4; word-break: break-all; }
          .mufy-status.success { color: var(--text-sub); }

          .mufy-tabs { display: flex; gap: 16px; padding: 0 20px; border-bottom: 1px solid var(--border-color); margin-bottom: 10px; }
          .mufy-tab { background: transparent; border: none; color: var(--text-sub); font-size: 13px; padding: 8px 0; cursor: pointer; transition: color 0.3s; position: relative; font-weight: 500; }
          .mufy-tab.active { color: #fff; }
          .mufy-tab.active::after { content: ''; position: absolute; bottom: -1px; left: 0; width: 100%; height: 2px; background: #fff; border-radius: 2px; }

          .mufy-actions { display: flex; justify-content: space-between; align-items: center; padding: 0 20px 10px; }
          .mufy-action-btn { background: transparent; border: 1px solid var(--border-color); color: var(--text-sub); padding: 6px 12px; border-radius: 20px; font-size: 12px; cursor: pointer; transition: all 0.2s; }
          .mufy-action-btn:active { color: #fff; border-color: #555; }
          .mufy-action-btn.primary { background: #fff; color: #000; border: none; }
          .mufy-action-btn.primary:active { background: #ccc; }

          #mufy-ar-content { flex: 1; overflow-y: auto; padding: 0 20px 20px; }
          #mufy-ar-content::-webkit-scrollbar { width: 4px; }
          #mufy-ar-content::-webkit-scrollbar-thumb { background: #333; border-radius: 4px; }

          .mufy-row-wrap { border-bottom: 1px solid var(--border-color); transition: background 0.2s; }
          .mufy-row-wrap.mufy-link { display: block; text-decoration: none; color: inherit; }
          .mufy-row-wrap:active { background: rgba(255,255,255,0.02); }

          .mufy-row { display: flex; justify-content: space-between; align-items: center; padding: 14px 10px; cursor: pointer; }
          .mufy-row.is-top .mufy-name { color: #fff; font-weight: 600; }

          .mufy-row-left { display: flex; align-items: center; gap: 12px; min-width: 0; }
          .mufy-rank { font-size: 12px; color: var(--text-dark); font-family: monospace; width: 20px; flex: none; }
          .mufy-avatar-wrap { width: 36px; height: 36px; border-radius: 50%; overflow: hidden; background: #222; flex: none; border: 1px solid rgba(255,255,255,0.05); }
          .mufy-avatar { width: 100%; height: 100%; object-fit: cover; }
          .mufy-avatar-placeholder { width: 100%; height: 100%; background: #1a1a1a; }

          .mufy-info { min-width: 0; }
          .mufy-name { font-size: 14px; color: var(--text-main); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-bottom: 4px; display: flex; align-items: center; gap: 6px; }
          .mufy-sub-text { font-size: 11px; color: var(--text-sub); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
          .mufy-hl { color: #aaa; }
          .text-danger { color: #ff5252 !important; font-weight: 500;}

          .mufy-row-right { display: flex; align-items: baseline; gap: 4px; flex: none; }
          .mufy-score { font-size: 16px; font-weight: 600; font-family: monospace; color: #fff; }
          .mufy-score-unit { font-size: 10px; color: var(--text-sub); }

          .mufy-score.is-done { color: #fff; }
          .mufy-score.is-loading { color: #666; font-size: 11px; font-weight: normal; }
          .mufy-score.is-pending { color: #444; font-size: 11px; font-weight: normal; }
          .mufy-score.is-empty { color: #444; font-size: 11px; font-weight: normal; }
          .mufy-score.is-err { color: #ff5252; font-size: 11px; font-weight: normal; }

          .mufy-goto { font-size: 12px; color: var(--text-dark); margin-left: 6px; transition: color 0.2s; }
          .mufy-row-wrap:active .mufy-goto { color: #fff; }

          .mufy-sub-list { background: var(--bg-sub); border-left: 1px solid #333; margin: 0 10px 12px 36px; border-radius: 0 8px 8px 0; padding: 6px 0; }
          .mufy-sub-item { display: flex; justify-content: space-between; align-items: center; padding: 8px 14px; text-decoration: none; transition: background 0.2s; }
          .mufy-sub-item:active { background: rgba(255,255,255,0.03); }
          .mufy-sub-name { font-size: 12px; color: var(--text-main); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 50%; }
          .mufy-sub-rounds { font-size: 11px; color: var(--text-dark); font-family: monospace; }
          .mufy-sub-rounds.has-rounds { color: var(--text-main); }
          .mufy-sub-rounds.is-dead { color: #ff5252; font-family: sans-serif; }

          .mufy-explore-wrap { padding: 10px 14px 4px; text-align: right; border-top: 1px dashed #222; margin-top: 4px; }
          .mufy-explore-btn { display: inline-block; color: var(--text-sub); text-decoration: none; font-size: 11px; transition: color 0.2s; }
          .mufy-explore-btn:active { color: #fff; }

          .mufy-sub-empty { padding: 10px 14px; font-size: 12px; color: var(--text-dark); font-style: italic; }
          .mufy-empty { text-align: center; color: var(--text-dark); padding: 40px 20px; font-size: 13px; }

          .mufy-disabled { cursor: not-allowed !important; opacity: 0.6; }

          /* 🌟 纯净截图模式 */
          #mufy-ar-modal.mufy-screenshot-mode .mufy-tools,
          #mufy-ar-modal.mufy-screenshot-mode .mufy-actions,
          #mufy-ar-modal.mufy-screenshot-mode .mufy-header-actions {
              display: none !important;
          }
          #mufy-ar-modal.mufy-screenshot-mode .mufy-header {
              justify-content: center;
              text-align: center;
              padding-bottom: 0;
          }
          #mufy-ar-modal.mufy-screenshot-mode .mufy-tabs {
              justify-content: center;
              border-bottom: none;
              margin-bottom: 15px;
              pointer-events: none;
          }
          #mufy-ar-modal.mufy-screenshot-mode .mufy-tab.active::after {
              display: none;
          }
          #mufy-ar-modal.mufy-screenshot-mode #mufy-ar-content::-webkit-scrollbar {
              display: none;
          }

          #mufy-exit-screenshot {
              display: none;
              position: absolute;
              top: 12px;
              right: 12px;
              z-index: 2147483648;
              width: 32px;
              height: 32px;
              border-radius: 50%;
              background: rgba(255,255,255,0.1);
              color: #fff;
              border: 1px solid rgba(255,255,255,0.2);
              cursor: pointer;
              font-size: 16px;
              line-height: 1;
              align-items: center;
              justify-content: center;
              backdrop-filter: blur(4px);
              transition: background 0.2s;
          }
          #mufy-exit-screenshot:active {
              background: rgba(255,255,255,0.3);
          }
          #mufy-ar-modal.mufy-screenshot-mode #mufy-exit-screenshot {
              display: flex !important;
          }

          /* 极简相机按钮样式 */
          #mufy-screenshot-btn {
              background: transparent;
              border: none;
              color: var(--text-sub);
              cursor: pointer;
              padding: 0;
              display: flex;
              align-items: center;
              justify-content: center;
              transition: color 0.2s;
          }
          #mufy-screenshot-btn:hover {
              color: #fff;
          }
        `;
        document.documentElement.appendChild(style);

        const btn = document.createElement('button');
        btn.id = 'mufy-ar-btn'; btn.innerHTML = '✦'; document.body.appendChild(btn);

        const modal = document.createElement('div');
        modal.id = 'mufy-ar-modal';
        modal.innerHTML = `
          <button id="mufy-exit-screenshot" title="退出截图模式">✕</button>

          <div class="mufy-header">
            <div class="mufy-header-text">
              <h2>我好歹也是个马粪孝女啊</h2>
              <p>看看你到底为多少癌鸭花了多少米</p>
            </div>
            <div class="mufy-header-actions" style="display:flex; gap:12px; align-items:center;">
              <button id="mufy-screenshot-btn" title="纯净截图模式">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"></path>
                  <circle cx="12" cy="13" r="4"></circle>
                </svg>
              </button>
              <button class="mufy-close" id="mufy-ar-close">×</button>
            </div>
          </div>

          <div class="mufy-tools">
            <div class="mufy-search-box">
              <input type="text" id="mufy-ar-single-input" class="mufy-input" placeholder="粘贴角色链接、分享链接或 ID...">
              <button id="mufy-ar-single-btn" class="mufy-btn">查询</button>
            </div>
            <div id="mufy-ar-single-result" style="display:none; padding: 12px; background: var(--bg-card); border-radius: 8px; font-size: 13px; border: 1px solid var(--border-color);"></div>
          </div>

          <div class="mufy-tabs">
            <button id="tab-role" class="mufy-tab active">你老公</button>
            <button id="tab-author" class="mufy-tab">你婆婆</button>
          </div>

          <div class="mufy-actions">
             <div id="mufy-ar-status" class="mufy-status success">准备ok</div>
             <div style="display:flex; gap:8px;">
                <button id="mufy-ar-clear" class="mufy-action-btn">清缓存</button>
                <button id="mufy-ar-scan" class="mufy-action-btn primary">扫描</button>
             </div>
          </div>

          <div class="mufy-tools" style="padding-bottom: 10px;">
             <input type="text" id="mufy-ar-search" class="mufy-input" style="background:var(--bg-card); border:1px solid var(--border-color); border-radius:8px; padding: 8px 12px;" placeholder="在榜单中搜索角色或作者...">
             <div id="mufy-ar-manual-wrap" style="display:none; margin-top: 8px; font-size: 12px; color: #fff;">
                <span style="color: #888;">手动填 ID:</span>
                <input type="text" id="mufy-ar-id-input" class="mufy-input" style="border:1px solid #333; border-radius:4px; padding:6px; width: 160px;">
                <button id="mufy-ar-id-save" class="mufy-action-btn">保存</button>
             </div>
          </div>

          <div id="mufy-ar-content"></div>
        `;
        document.body.appendChild(modal);

        const statusEl = modal.querySelector('#mufy-ar-status');
        const contentEl = modal.querySelector('#mufy-ar-content');
        const tabAuthor = modal.querySelector('#tab-author');
        const tabRole = modal.querySelector('#tab-role');
        const searchInput = modal.querySelector('#mufy-ar-search');
        const scanBtn = modal.querySelector('#mufy-ar-scan');
        const clearBtn = modal.querySelector('#mufy-ar-clear');

        const singleInput = modal.querySelector('#mufy-ar-single-input');
        const singleBtn = modal.querySelector('#mufy-ar-single-btn');
        const singleResultEl = modal.querySelector('#mufy-ar-single-result');

        const manualWrap = modal.querySelector('#mufy-ar-manual-wrap');
        const idInput = modal.querySelector('#mufy-ar-id-input');
        const idSaveBtn = modal.querySelector('#mufy-ar-id-save');

        const screenshotBtn = modal.querySelector('#mufy-screenshot-btn');
        const exitScreenshotBtn = modal.querySelector('#mufy-exit-screenshot');

        const setStatus = (text, isError = false) => {
            statusEl.textContent = text;
            if (isError) statusEl.classList.remove('success');
            else statusEl.classList.add('success');
        };

        function openModal() {
            modal.style.setProperty('display', 'flex', 'important');
            modal.style.setProperty('visibility', 'visible', 'important');
            modal.style.setProperty('pointer-events', 'auto', 'important');

            if (!state.isScanning) {
                const cacheTime = loadCache();
                if (cacheTime) {
                    setStatus(`已加载本地缓存 (${cacheTime})`);
                    renderContent(contentEl);
                } else {
                    setStatus('暂无数据，请点击扫描。');
                }
            }
        }

        function closeModal() {
            modal.style.setProperty('display', 'none', 'important');
            modal.style.setProperty('pointer-events', 'none', 'important');
            modal.classList.remove('mufy-screenshot-mode');
        }

        btn.addEventListener('pointerdown', function(e) {
            e.preventDefault();
            e.stopPropagation();
            openModal();
        }, true);

        modal.querySelector('#mufy-ar-close').addEventListener('click', function(e) {
            e.preventDefault();
            e.stopPropagation();
            closeModal();
        }, true);

        screenshotBtn.addEventListener('click', () => {
            modal.classList.add('mufy-screenshot-mode');
        });

        exitScreenshotBtn.addEventListener('click', () => {
            modal.classList.remove('mufy-screenshot-mode');
        });

        function switchTab(tab) {
            state.activeTab = tab;
            tabRole.className = `mufy-tab ${tab === 'role' ? 'active' : ''}`;
            tabAuthor.className = `mufy-tab ${tab === 'author' ? 'active' : ''}`;
            renderContent(contentEl);
        }
        tabRole.addEventListener('click', () => switchTab('role'));
        tabAuthor.addEventListener('click', () => switchTab('author'));

        searchInput.addEventListener('input', (e) => {
            state.searchQuery = e.target.value.trim();
            if (!state.isScanning) renderContent(contentEl);
        });

        contentEl.addEventListener('click', (e) => {
            const link = e.target.closest('a');
            if (link && state.isScanning) {
                e.preventDefault();
                e.stopPropagation();

                if (!statusEl.textContent.includes('扫完了再去')) {
                    setStatus('⏳ 正在拼命扫描中，扫完了再去宠幸TA吧！', true);
                    setTimeout(() => {
                        if (state.isScanning) setStatus(`正在扫描...`);
                    }, 3000);
                }
                return;
            }

            const toggleBtn = e.target.closest('.mufy-author-toggle');
            if (toggleBtn) {
                const id = toggleBtn.getAttribute('data-id');
                if (state.expandedAuthors.has(id)) {
                    state.expandedAuthors.delete(id);
                } else {
                    state.expandedAuthors.add(id);
                }
                renderContent(contentEl);
            }
        });

        clearBtn.addEventListener('click', () => {
            if(confirm('确定要清空本地缓存和账号记忆吗？')) {
                localStorage.removeItem(CACHE_DATA_KEY);
                localStorage.removeItem(STORAGE_MY_ID_KEY);
                state.roles = [];
                state.authors = [];
                state.myUserId = '';
                state.expandedAuthors.clear();
                renderContent(contentEl);
                setStatus('缓存已清空');
            }
        });

        idSaveBtn.addEventListener('click', () => {
            const manualId = idInput.value.trim();
            if (!manualId) return;
            localStorage.setItem(STORAGE_MY_ID_KEY, manualId);
            state.myUserId = manualId;
            manualWrap.style.display = 'none';
            alert('账号 ID 已保存。');
        });

        singleBtn.addEventListener('click', async () => {
            const rawInput = singleInput.value.trim();
            if (!rawInput) return;

            singleBtn.disabled = true;
            singleBtn.textContent = '查询中...';
            singleResultEl.style.display = 'block';
            singleResultEl.innerHTML = '<span style="color:#666;">正在解析链接...</span>';

            try {
                const uuidRegex = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
                let targetId = '';
                let match = rawInput.match(uuidRegex);
                if (match) {
                    targetId = match[0];
                } else {
                    try {
                        const urlObj = new URL(rawInput);
                        const searchParams = urlObj.searchParams;
                        if (searchParams.has('roleId')) targetId = searchParams.get('roleId');
                        else if (searchParams.has('id')) targetId = searchParams.get('id');
                        else if (searchParams.has('shareCode')) {
                            const shareCode = searchParams.get('shareCode');
                            singleResultEl.innerHTML = '<span style="color:#666;">正在解析分享码...</span>';
                            const tryApis = [
                                `${API_BASE}/api/characters/get?shareCode=${shareCode}`,
                                `${API_BASE}/api/characters/share/info?shareCode=${shareCode}`,
                                `${API_BASE}/api/characters/share?shareCode=${shareCode}`,
                                `${API_BASE}/api/share/info?shareCode=${shareCode}`
                            ];
                            for (const api of tryApis) {
                                try {
                                    const res = await mufyGet(api);
                                    if (res && res.code === 200 && res.data) {
                                        const d = res.data.data || res.data;
                                        const cid = d.id || d.characterId;
                                        if (cid) { targetId = cid; break; }
                                    }
                                } catch(e) {}
                            }
                            if (!targetId && window.location.href.includes(shareCode)) {
                                const locMatch = window.location.href.match(uuidRegex);
                                if (locMatch) targetId = locMatch[0];
                            }
                            if (!targetId) throw new Error('无法解析该分享码。');
                        }
                    } catch(e) { if (e.message.includes('无法解析')) throw e; }
                }

                if (!targetId) throw new Error('无效的 ID 或链接。');

                const myId = state.myUserId || await getMyUserId();
                if (!myId) throw new Error('缺失 UserID，请先点击全量扫描。');

                let charName = '未知角色';
                let authorName = '未知作者';
                let isExpired = false;
                const cachedRole = state.roles.find(r => isSameId(r.characterId, targetId));
                if (cachedRole) {
                    charName = cachedRole.name;
                    authorName = cachedRole.authorName;
                } else {
                    try {
                        const rRes = await mufyGet(`${API_BASE}/api/characters/get?id=${encodeURIComponent(targetId)}`);
                        if (rRes.code === 200) {
                            const d = rRes.data?.data || rRes.data || rRes;
                            charName = d.name || d.characterName || d.title || '未知角色';
                            const authorObj = d.author || d.creator || d.user || {};
                            authorName = d.authorName || authorObj.username || authorObj.name || '未知作者';
                        } else if (rRes.error === 'share_link_expired') {
                            isExpired = true;
                        }
                    } catch (e) {
                        if (e.isExpired) isExpired = true;
                    }
                }

                singleResultEl.innerHTML = '<span style="color:#666;">正在查询轮数...</span>';

                const result = await fetchMyRoundsFromComments(targetId, myId);

                let resultHtml = '';
                if (result.rounds > 0) {
                    resultHtml = `
                        <div style="font-size: 13px; color: #888; margin-bottom: 8px;">${esc(charName)} ${result.isExpired ? '<span style="color:#ff5252">(已失效)</span>' : ''}</div>
                        <div style="font-size: 24px; font-weight: 600; color: #fff; font-family: monospace;">
                            ${result.rounds} <span style="font-size: 12px; color: #666; font-family: sans-serif; font-weight: normal;">轮</span>
                        </div>
                    `;
                } else if (result.hasCommented) {
                    resultHtml = `<div style="color: #888;">曾评论过，但接口未返回具体轮数。</div>`;
                } else if (result.isExpired) {
                    resultHtml = `<div style="color: #ff5252;">你两见过，没嫖过，你也嫖不了了。</div>`;
                } else {
                    resultHtml = `<div style="color: #666;">未找到该角色下的评论记录。</div>`;
                }
                singleResultEl.innerHTML = resultHtml;

            } catch (err) {
                singleResultEl.innerHTML = `<span style="color:#888;">错误：${err.message}</span>`;
            } finally {
                singleBtn.disabled = false;
                singleBtn.textContent = '查询';
            }
        });

        scanBtn.addEventListener('click', async () => {
            if (state.loading) return;
            state.loading = true;
            state.isScanning = true;
            state.expandedAuthors.clear();
            scanBtn.disabled = true;
            contentEl.innerHTML = '';

            try {
                setStatus('正在识别身份...');
                state.myUserId = await getMyUserId(setStatus);

                if (!state.myUserId) {
                    manualWrap.style.display = 'block';
                    throw new Error('自动获取 ID 失败，请手动填入。');
                }

                setStatus('正在获取角色列表...');
                let roles = await fetchAllCharacters(setStatus);
                if (!roles.length) throw new Error("未找到任何角色。");

                setStatus('正在补全作者信息并检查存活状态...');
                const missingAuthorRoles = roles.filter(r => !r.authorId);
                if (missingAuthorRoles.length > 0) {
                    for (let i = 0; i < missingAuthorRoles.length; i += 3) {
                        const batch = missingAuthorRoles.slice(i, i + 3);
                        await Promise.all(batch.map(async (role) => {
                            try {
                                const res = await mufyGet(`${API_BASE}/api/characters/get?id=${encodeURIComponent(role.characterId)}`);
                                if (res.code === 200 && res.data) {
                                    const d = res.data?.data || res.data || res;
                                    const authorObj = d.author || d.creator || d.user || d.character?.author || {};
                                    const aId = pick(d, 'authorId', 'creatorId') || pick(authorObj, 'id', 'userId');
                                    if (aId) {
                                        role.authorId = String(aId);
                                        role.authorName = pick(d, 'authorName') || pick(authorObj, 'username', 'name', 'nickname') || '';
                                    }
                                }
                            } catch(e) {
                                if (e.isExpired) role.isExpired = true;
                            }
                        }));
                        await sleep(100);
                    }
                }

                state.roles = roles;

                const initialAuthors = new Map();
                roles.forEach(r => {
                    const aId = r.authorId || 'unknown';
                    if (!initialAuthors.has(aId)) {
                        initialAuthors.set(aId, {
                            id: aId,
                            name: r.authorName || (aId === 'unknown' ? '未知/失效作者' : '未知作者'),
                            avatarUrl: '',
                            totalRounds: 0,
                            cards: 0,
                            level: 0,
                            rolesCount: 0,
                            hasScanned: false,
                            isScanning: false
                        });
                    }
                    initialAuthors.get(aId).rolesCount += 1;
                });
                state.authors = [...initialAuthors.values()];

                switchTab('role');
                setStatus('开始并发扫描角色和作者...');

                const rolesList = state.roles;
                const authorsList = state.authors;

                await Promise.all([
                    streamScanRoles(
                        rolesList,
                        state.myUserId,
                        (c, t) => setStatus(`正在扫描角色 (${c}/${t})...`),
                        () => {
                            const sorted = state.isScanning ? rolesList : [...rolesList].sort((a, b) => b.rounds - a.rounds);
                            state.roles = sorted;
                            renderContent(contentEl);
                        }
                    ),
                    streamScanAuthors(
                        authorsList,
                        (c, t) => setStatus(`正在扫描作者 (${c}/${t})...`),
                        () => {
                            const sorted = state.isScanning ? authorsList : [...authorsList].sort((a, b) => b.totalRounds - a.totalRounds);
                            state.authors = sorted;
                            renderContent(contentEl);
                        }
                    )
                ]);

                state.isScanning = false;
                state.roles = [...rolesList].sort((a, b) => b.rounds - a.rounds);
                state.authors = [...authorsList].sort((a, b) => b.totalRounds - a.totalRounds);
                saveCache();

                setStatus(`扫描完成，现在可以点进去看啦！`);
                renderContent(contentEl);

            } catch (err) {
                setStatus('❌ ' + err.message, true);
            } finally {
                state.loading = false;
                state.isScanning = false;
                scanBtn.disabled = false;
                btn.disabled = false;
            }
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', mount, { once: true });
    } else {
        mount();
    }
})();
