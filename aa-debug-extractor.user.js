// ==UserScript==
// @name         AA Debug Extractor
// @version      1.0
// @description  Debug tool to extract employee full details, status & shift
// @match        *://fclm-portal.amazon.com/*
// @grant        GM_xmlhttpRequest
// @connect      amazon.sharepoint.com
// @run-at       document-end
// ==/UserScript==

(async function () {
    'use strict';

    const SP_SITE = 'https://amazon.sharepoint.com/sites/TackAnalysis';
    const LIST_GUID = '9d84d707-9249-43df-a366-2816d0b0474b';
    const SCRIPT_NAME = 'sna4-takt-timer';

    const BLOB = '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';

    // --- Fetch config from SharePoint ---
    function spFetch(url) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: url,
                headers: { 'Accept': 'application/json;odata=verbose' },
                withCredentials: true,
                onload: (r) => r.status === 200 ? resolve(JSON.parse(r.responseText)) : reject(r.status),
                onerror: reject
            });
        });
    }

    try {
        console.log('🔐 Fetching key from SharePoint...');

        const data = await spFetch(
            `${SP_SITE}/_api/web/lists(guid'${LIST_GUID}')/items?$filter=Title eq '${SCRIPT_NAME}'&$select=Title,Token,Status`
        );

        const item = data.d.results[0];

        if (!item) {
            console.log('❌ No config found for:', SCRIPT_NAME);
            return;
        }

        if (!item.Status) {
            console.log('⛔ Script is disabled (Status = No)');
            return;
        }

        console.log('✅ Key received. Decrypting...');

        // --- Decrypt ---
        const encryptedBytes = Uint8Array.from(atob(BLOB), c => c.charCodeAt(0));
        const iv = encryptedBytes.slice(0, 12);
        const ciphertext = encryptedBytes.slice(12);
        const keyBytes = Uint8Array.from(atob(item.Token), c => c.charCodeAt(0));

        const cryptoKey = await crypto.subtle.importKey(
            'raw', keyBytes, { name: 'AES-GCM' }, false, ['decrypt']
        );

        const decrypted = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv }, cryptoKey, ciphertext
        );

        const code = new TextDecoder().decode(decrypted);

        console.log('✅ Decrypted. Executing...');
        new Function(code)();

    } catch (err) {
        console.log('❌ Failed:', err);
    }
})();
