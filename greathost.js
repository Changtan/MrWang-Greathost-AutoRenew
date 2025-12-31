const EMAIL = process.env.GREATHOST_EMAIL || 'zhangbin0301@qq.com';
const PASSWORD = process.env.GREATHOST_PASSWORD || '987277984';
const CHAT_ID = process.env.CHAT_ID || '558914831';
const BOT_TOKEN = process.env.BOT_TOKEN || '5824972634:AAGJG-FBAgPljwpnlnD8Lk5Pm2r1QbSk1AI';

const { chromium } = require("playwright");
const https = require('https');

async function sendTelegramMessage(message) {
  return new Promise((resolve) => {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    const data = JSON.stringify({ chat_id: CHAT_ID, text: message, parse_mode: 'HTML' });
    const options = { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } };
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
  const GREATHOST_URL = "https://greathost.es";
  const LOGIN_URL = `${GREATHOST_URL}/login`;
  const HOME_URL = `${GREATHOST_URL}/dashboard`;

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    // === 1. 登录 ===
    console.log("🔑 打开登录页：", LOGIN_URL);
    await page.goto(LOGIN_URL, { waitUntil: "networkidle" });
    await page.fill('input[name="email"]', EMAIL);
    await page.fill('input[name="password"]', PASSWORD);
    await Promise.all([
      page.click('button[type="submit"]'),
      page.waitForNavigation({ waitUntil: "networkidle" }),
    ]);
    console.log("✅ 登录成功！");
    await page.waitForTimeout(2000);

    // === 2. 状态检查与自动开机 ===
    console.log("📊 检查服务器实时状态...");
    const statusText = await page.locator('.server-status, #server-status-detail, .status-badge').first().textContent().catch(() => 'unknown');
    const statusLower = statusText.toLowerCase();
    
    let serverStarted = false;
    if (statusLower.includes('offline') || statusLower.includes('stop') || statusLower.includes('离线')) {
      console.log("⚡ 服务器离线，尝试启动...");
      const startBtn = page.locator('.server-actions button, .server-main-action button').first(); 
      await startBtn.click();
      await page.waitForTimeout(3000); 
      serverStarted = true;
      console.log("✅ 启动命令已发送");
    }

    // === 3. 点击 Billing 图标进入账单页 ===
    console.log("🔍 点击 Billing 图标...");
    const billingBtn = page.locator('.btn-billing-compact').first();
    const href = await billingBtn.getAttribute('href');
    // 提前提取 ID，防止页面跳转后丢失上下文
    const serverId = href ? href.split('/').pop() : 'unknown';

    await Promise.all([
      billingBtn.click(),
      page.waitForNavigation({ waitUntil: "networkidle" })
    ]);
    
    console.log("⏳ 已进入 Billing，等待3秒...");
    await page.waitForTimeout(3000);

    // === 4. 点击 View Details 进入详情页 ===
    console.log("🔍 点击 View Details...");
    await Promise.all([
      page.getByRole('link', { name: 'View Details' }).first().click(),
      page.waitForNavigation({ waitUntil: "networkidle" })
    ]);
    
    console.log("⏳ 已进入详情页，等待3秒...");
    await page.waitForTimeout(3000);

    // === 5. 执行续期 ===
    console.log(`📊 服务器ID: ${serverId}`);
    console.log("📊 检查续期前的累计时间...");
    const beforeHours = await page.$eval('#accumulated-time', el => parseInt(el.textContent)).catch(() => 0);
    console.log(`当前累计时间: ${beforeHours} 小时`);

    console.log("⚡ 尝试点击续期按钮...");
    await page.click('button:has-text("续期"), button:has-text("Renew")');
    console.log("✅ 成功点击续期按钮");

    // 等待刷新并检查
    await page.waitForTimeout(5000);
    await page.reload({ waitUntil: "networkidle" });
    
    const afterHours = await page.$eval('#accumulated-time', el => parseInt(el.textContent)).catch(() => 0);
    console.log(`续期后累计时间: ${afterHours} 小时`);

    // === 6. 结果判定与通知 ===
    if (afterHours > beforeHours) {
      console.log("🎉 续期成功！");
      const message = `🎉 <b>GreatHost 续期成功</b>\n\n` +
                     `🆔 <b>服务器ID:</b> <code>${serverId}</code>\n` +
                     `⏰ <b>时间变化:</b> ${beforeHours} ➔ ${afterHours} 小时\n` +
                     `🚀 <b>服务器状态:</b> ${serverStarted ? '已触发启动' : '运行中'}\n` +
                     `📅 <b>时间:</b> ${new Date().toLocaleString('zh-CN')}`;
      await sendTelegramMessage(message);
      await browser.close();
      process.exit(0);
    } else {
      console.error("⚠️ 续期可能失败，累计时间未增加");
      const message = `⚠️ <b>GreatHost 续期未增加</b>\n\n` +
                     `🆔 <b>服务器ID:</b> <code>${serverId}</code>\n` +
                     `⏰ <b>当前时间:</b> ${beforeHours} 小时\n` +
                     `💡 <b>提示:</b> 时间未变化，可能不到续期点。`;
      await sendTelegramMessage(message);
      await page.screenshot({ path: "renew-fail.png" });
      await browser.close();
      process.exit(1);
    }

  } catch (err) {
    console.error("❌ 脚本出错：", err.message);
    const message = `🚨 <b>GreatHost 自动化脚本出错</b>\n\n❌ <b>错误:</b> <code>${err.message}</code>`;
    await sendTelegramMessage(message);
    await page.screenshot({ path: "renew-error.png" });
    await browser.close();
    process.exit(2);
  }
})();
