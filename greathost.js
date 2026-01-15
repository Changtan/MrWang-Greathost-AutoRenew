const EMAIL = process.env.GREATHOST_EMAIL || '';
const PASSWORD = process.env.GREATHOST_PASSWORD || '';
const CHAT_ID = process.env.CHAT_ID || '';
const BOT_TOKEN = process.env.BOT_TOKEN || '';
// === SOCKS5 代理配置 ===
const PROXY_URL = (process.env.PROXY_URL || "").trim();

// 🛑 核心修改：使用 firefox 避开 Chromium 的 SOCKS5 认证限制
const { firefox } = require("playwright");
const https = require('https');

async function sendTelegramMessage(message) {
    return new Promise((resolve) => {
        const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
        const data = JSON.stringify({ chat_id: CHAT_ID, text: message, parse_mode: 'HTML' });
        const options = { 
            method: 'POST', 
            headers: { 
                'Content-Type': 'application/json', 
                'Content-Length': Buffer.byteLength(data) 
            } 
        };
        const req = https.request(url, options, (res) => {
            res.on('data', () => {});
            res.on('end', () => resolve());
        });
        req.on('error', () => resolve());
        req.write(data);
        req.end();
    });
}

(async () => {
    // === 目标 URL 变量 ===
    const GREATHOST_URL = "https://greathost.es";    
    const LOGIN_URL = `${GREATHOST_URL}/login`;
    const HOME_URL = `${GREATHOST_URL}/dashboard`;
    const BILLING_URL = `${GREATHOST_URL}/billing/free-servers`;
    
    let proxyStatusTag = PROXY_URL ? `🔒 代理模式 (通过环境注入)` : "🌐 直连模式";
    let serverStarted = false;

    let browser;
    try {
        console.log(`🚀 任务启动 | 引擎: Firefox | ${proxyStatusTag}`);
        
        // 1. 启动浏览器 - 这里完全不传 proxy 参数，防止 Playwright 报错
        // 代理将由 YAML 中的 ALL_PROXY 环境变量在系统层处理
        browser = await firefox.launch({ headless: true });

        // 2. 创建上下文 - 确保这里只有这一处声明
        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0',
            viewport: { width: 1280, height: 720 },
            locale: 'es-ES'
        });

        // 3. 创建页面
        const page = await context.newPage();

        // --- 抹除特征 ---
        await page.addInitScript(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        });

        // 4. Firefox 专属伪装（移除所有 Chrome 特征，确保持一致性）
        await page.addInitScript(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            Object.defineProperty(navigator, 'languages', { get: () => ['es-ES', 'es', 'en'] });
            Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
            const getParameter = WebGLRenderingContext.prototype.getParameter;
            WebGLRenderingContext.prototype.getParameter = function(parameter) {
                if (parameter === 37445) return 'Intel Inc.';
                if (parameter === 37446) return 'Intel(R) Iris(TM) Plus Graphics 640';
                return getParameter.apply(this, [parameter]);
            };
        });

        // 5. 代理 IP 检测（熔断机制）
        if (proxyData) {
            console.log("🌍 [Check] 正在检测代理出口 IP...");
            try {
                await page.goto("https://api.ipify.org?format=json", { timeout: 30000 });
                const ipInfo = JSON.parse(await page.innerText('body'));
                console.log(`✅ 当前出口 IP: ${ipInfo.ip}`);
            } catch (e) {
                await sendTelegramMessage(`🚨 <b>GreatHost 代理异常</b>\n原因: ${e.message}`);
                throw new Error("Proxy Check Failed"); 
            }
        }

        // 6. 登录流程
        console.log("🔑 步骤 1: 访问登录页面...");
        await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });
        await page.fill('input[name="email"]', EMAIL);
        await page.fill('input[name="password"]', PASSWORD);
        
        console.log("🔑 步骤 2: 提交登录信息...");
        await Promise.all([
            page.click('button[type="submit"]'),
            page.waitForNavigation({ waitUntil: "networkidle" }),
        ]);
        
        if (page.url().includes('login')) {
            throw new Error("登录失败，页面仍留在登录页，请检查凭据或验证码。");
        }
        console.log("✅ 登录成功！");

        // 7. 自动检查服务器并尝试开机
        console.log("📊 步骤 3: 检查服务器运行状态...");
        await page.goto(HOME_URL, { waitUntil: "networkidle" });
        
        // 定位离线标识（根据 GreatHost 实际 DOM 调整）
        const offlineIndicator = page.locator('span.badge-danger:has-text("Offline"), .status-offline').first();
        if (await offlineIndicator.isVisible()) {
            console.log("⚠️ 检测到服务器离线，尝试发送启动指令...");
            const startBtn = page.locator('button:has-text("Start"), .btn-start').first();
            if (await startBtn.isVisible()) {
                await startBtn.click();
                serverStarted = true;
                await page.waitForTimeout(5000); // 等待启动反馈
                console.log("✅ 启动指令已发出");
            }
        } else {
            console.log("🟢 服务器已在运行中。");
        }

        // 8. 续期业务逻辑
        console.log("🔍 步骤 4: 进入 Billing 免费服务器列表...");
        await page.goto(BILLING_URL, { waitUntil: "networkidle" });

        // 点击 "View Details"
        console.log("🔍 步骤 5: 点击 View Details 进入详情页...");
        const detailLink = page.getByRole('link', { name: 'View Details' }).first();
        if (!(await detailLink.isVisible())) {
            throw new Error("未找到 View Details 链接，可能没有有效的免费服务器。");
        }
        await detailLink.click();
        await page.waitForNavigation({ waitUntil: "networkidle" });
        
        const serverId = page.url().split('/').pop() || 'unknown';
        const timeSelector = '#accumulated-time';

        // 获取续期前时长
        const beforeHoursText = await page.textContent(timeSelector).catch(() => "0h");
        const beforeHours = parseInt(beforeHoursText.replace(/[^0-9]/g, '')) || 0;
        console.log(`⏰ 续期前累计时长: ${beforeHours}h`);

        // 检查续期按钮状态
        const renewBtn = page.locator('#renew-free-server-btn');
        const btnContent = await renewBtn.innerHTML();

        const getReport = (icon, title, hours, detail) => {
            return `${icon} <b>GreatHost ${title}</b>\n\n` +
                   `🆔 <b>服务器ID:</b> <code>${serverId}</code>\n` +
                   `⏰ <b>当前时长:</b> ${hours}h\n` +
                   `🚀 <b>开机状态:</b> ${serverStarted ? '✅ 已触发开机' : '运行中'}\n` +
                   `🌐 <b>连接模式:</b> ${proxyStatusTag}\n` + 
                   `📅 <b>时间:</b> ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}\n` +
                   `💡 <b>详情:</b> ${detail}`;
        };

        if (btnContent.includes('Wait')) {
            const waitMatch = btnContent.match(/\d+/);
            const waitTime = waitMatch ? waitMatch[0] : "未知";
            console.log(`⏳ 按钮锁定中，需等待 ${waitTime} 分钟`);
            await sendTelegramMessage(getReport('⏳', '续期冷却中', beforeHours, `还需等待 ${waitTime} 分钟`));
            return;
        }

        // 9. 执行模拟真人点击续期
        console.log("⚡ 步骤 6: 模拟真人点击续期按钮...");
        await page.mouse.wheel(0, 300); // 向下滚动
        await page.waitForTimeout(2000);
        await renewBtn.click({ force: true, delay: 150 });

        // 10. 等待同步并最终校验
        console.log("⏳ 步骤 7: 等待 20 秒处理数据写入...");
        await page.waitForTimeout(20000); 
        await page.reload({ waitUntil: "networkidle" });
        
        const afterHoursText = await page.textContent(timeSelector).catch(() => "0h");
        const afterHours = parseInt(afterHoursText.replace(/[^0-9]/g, '')) || 0;
        console.log(`⏰ 续期后累计时长: ${afterHours}h`);

        // 11. 发送最终通知
        if (afterHours > beforeHours) {
            console.log("🎉 续期成功！");
            await sendTelegramMessage(getReport('🎉', '续期成功', afterHours, `时长已从 ${beforeHours}h 成功增加`));
        } else {
            console.log("✅ 时长未变，可能已达上限或点击未生效。");
            await sendTelegramMessage(getReport('✅', '已检查', afterHours, '目前时长充足或点击受限，建议手动核实'));
        }

    } catch (err) {
        console.error("❌ 脚本运行崩溃:", err.message);
        // 如果不是主动触发的代理熔断，则发送崩溃通知
        if (!err.message.includes("Proxy Check Failed")) {
            await sendTelegramMessage(`🚨 <b>GreatHost 脚本崩溃</b>\n错误原因: <code>${err.message}</code>\n状态: ${proxyStatusTag}`);
        }
    } finally {
        if (browser) {
            console.log("🧹 [Exit] 正在关闭浏览器...");
            await browser.close();
        }
    }
})();
