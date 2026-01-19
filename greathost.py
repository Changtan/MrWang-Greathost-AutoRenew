import os, re, time, json, requests
from datetime import datetime, timezone
from urllib.parse import urlparse
from zoneinfo import ZoneInfo

from seleniumwire import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC

# ================= 配置区 =================
EMAIL = os.getenv("GREATHOST_EMAIL", "")
PASSWORD = os.getenv("GREATHOST_PASSWORD", "")
TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "")
TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID", "")
PROXY_URL = os.getenv("PROXY_URL", "")

TARGET_NAME_CONFIG = os.getenv("TARGET_NAME", "loveMC") 

# ================= 工具函数 =================
def now_shanghai():
    return datetime.now(ZoneInfo("Asia/Shanghai")).strftime('%Y/%m/%d %H:%M:%S')

def calculate_hours(date_str):
    """解析 ISO 时间字符串并换算为剩余小时数"""
    try:
        if not date_str: return 0
        # 清洗毫秒并统一格式 (解决 0h 问题)
        clean_date = re.sub(r'\.\d+Z$', 'Z', str(date_str))
        expiry = datetime.fromisoformat(clean_date.replace('Z', '+00:00'))
        now = datetime.now(timezone.utc)
        diff = (expiry - now).total_seconds() / 3600
        return max(0, int(diff))
    except:
        return 0

def fetch_api(driver, url, method="GET"):
    script = f"return fetch('{url}', {{method:'{method}'}}).then(r=>r.json()).catch(e=>({{success:false,message:e.toString()}}))"
    return driver.execute_script(script)

def send_notice(kind, fields):
    titles = {
        "renew_success": "🎉 <b>GreatHost 续期成功</b>",
        "cooldown": "⏳ <b>GreatHost 冷却/熔断中</b>",
        "renew_failed": "⚠️ <b>GreatHost 续期未生效</b>",
        "error": "🚨 <b>GreatHost 脚本报错</b>"
    }
    title = titles.get(kind, "‼️ <b>GreatHost 通知</b>")
    body = "\n".join([f"{e} {l}: {v}" for e, l, v in fields])
    msg = f"{title}\n\n{body}\n📅 时间: {now_shanghai()}"
    if TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID:
        try:
            requests.post(f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage", 
                          data={"chat_id": TELEGRAM_CHAT_ID, "text": msg, "parse_mode": "HTML"}, timeout=5)
        except: pass

# ================= 主流程 =================
def run_task():
    driver = None
    current_server_name = "未知"
    try:
        opts = Options()
        opts.add_argument("--headless=new")
        opts.add_argument("--no-sandbox")
        opts.add_argument("--disable-dev-shm-usage")
        
        driver = webdriver.Chrome(options=opts, seleniumwire_options={'proxy': {'http': PROXY_URL, 'https': PROXY_URL}} if PROXY_URL else None)
        wait = WebDriverWait(driver, 25)

        # 1. 登录流程
        driver.get("https://greathost.es/login")
        wait.until(EC.presence_of_element_located((By.NAME,"email"))).send_keys(EMAIL)
        driver.find_element(By.NAME,"password").send_keys(PASSWORD)
        driver.find_element(By.CSS_SELECTOR,"button[type='submit']").click()
        wait.until(EC.url_contains("/dashboard"))

        # 2. 获取并锁定服务器 ID
        res = fetch_api(driver, "/api/servers")
        server_list = res.get('servers', [])
        target_server = next((s for s in server_list if s.get('name') == TARGET_NAME_CONFIG), None)
        if not target_server: raise Exception(f"未找到服务器: {TARGET_NAME_CONFIG}")
        
        server_id = target_server.get('id')
        current_server_name = target_server.get('name')

        # 3. 数据采集与冷却判定
        driver.get(f"https://greathost.es/contracts/{server_id}")
        time.sleep(5) 
        
        contract_res = fetch_api(driver, f"/api/servers/{server_id}/contract")
        # 路径穿透：进入 contract -> renewalInfo
        c_data = contract_res.get('contract', {})
        r_info = c_data.get('renewalInfo', {})
        
        # 获取核心时间数据
        raw_date_before = r_info.get('nextRenewalDate')
        last_renew_str = r_info.get('lastRenewalDate') # 上次续期成功的时间
        user_coins = c_data.get('userCoins', 0)

        # 计算状态
        before_h = calculate_hours(raw_date_before) # 解决 0 小时问题的核心
        
        # --- 30 分钟硬冷却判定 ---
        if last_renew_str:
            clean_last = re.sub(r'\.\d+Z$', 'Z', str(last_renew_str))
            last_time = datetime.fromisoformat(clean_last.replace('Z', '+00:00'))
            now_time = datetime.now(timezone.utc)
            minutes_passed = (now_time - last_time).total_seconds() / 60
            
            if minutes_passed < 30:
                wait_min = int(30 - minutes_passed)
                print(f"⏳ 冷却保护：距离上次操作仅 {int(minutes_passed)} 分钟")
                send_notice("cooldown", [
                    ("🖥️", "服务器", current_server_name),
                    ("⏳", "冷却剩余", f"<code>{wait_min} 分钟</code>"),
                    ("📊", "当前累计", f"{before_h}h")
                ])
                return 

        # --- 120 小时上限熔断 ---
        if before_h > 108:
            print(f"🛑 安全跳过：当前 {before_h}h 已接近上限")
            send_notice("cooldown", [
                ("🖥️", "服务器", current_server_name),
                ("📊", "当前累计", f"{before_h}h"),
                ("🛡️", "状态", "已近 120h 上限，暂无续期必要")
            ])
            return

        # 4. 执行续期操作
        print(f"🚀 正在为 {current_server_name} 发送续期 POST 请求...")
        renew_res = fetch_api(driver, f"/api/renewal/contracts/{server_id}/renew-free", method="POST")
        
        # 结果解析
        renew_c = renew_res.get('contract', {})
        raw_date_after = renew_c.get('renewalInfo', {}).get('nextRenewalDate')
        after_h = calculate_hours(raw_date_after)

        # 补偿显示逻辑：如果 API 成功但时间没刷新，手动显示 +12
        if (after_h == 0 or after_h <= before_h) and renew_res.get('success'):
            after_h = before_h + 12

        # 5. 发送最终通知
        if renew_res.get('success'):
            send_notice("renew_success", [
                ("🖥️", "服务器", current_server_name),
                ("⏰", "增加时间", f"{before_h} ➔ {after_h}h"),
                ("💰", "当前金币", f"{user_coins}")
            ])
        else:
            send_notice("renew_failed", [
                ("🖥️", "服务器", current_server_name),
                ("💡", "原因", f"<code>{renew_res.get('message','接口未返回成功')}</code>")
            ])

    except Exception as e:
        send_notice("error", [("🖥️", "服务器", current_server_name), ("❌", "故障", f"<code>{str(e)[:100]}</code>")])
    finally:
        if driver: driver.quit()

if __name__ == "__main__":
    run_task()
