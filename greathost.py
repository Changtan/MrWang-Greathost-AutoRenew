import os, re, time, random, requests, json
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

# 初始配置名，可以为空
TARGET_NAME_CONFIG = os.getenv("TARGET_NAME", "loveMC") 

STATUS_MAP = {
    "running": ["🟢", "Running"],
    "starting": ["🟡", "Starting"],
    "stopped": ["🔴", "Stopped"],
    "offline": ["⚪", "Offline"],
    "suspended": ["🚫", "Suspended"]
}

# ================= 工具函数 =================
def now_shanghai():
    return datetime.now(ZoneInfo("Asia/Shanghai")).strftime('%Y/%m/%d %H:%M:%S')

def calculate_hours(date_str):
    """修复 0h 解析问题"""
    try:
        if not date_str: return 0
        clean_date = re.sub(r'\.\d+Z$', 'Z', date_str)
        expiry = datetime.fromisoformat(clean_date.replace('Z', '+00:00'))
        now = datetime.now(timezone.utc)
        return max(0, int((expiry - now).total_seconds() / 3600))
    except: return 0

def fetch_api(driver, url, method="GET"):
    script = f"return fetch('{url}', {{method:'{method}'}}).then(r=>r.json()).catch(e=>({{success:false,message:e.toString()}}))"
    res = driver.execute_script(script)
    print(f"📡 API 调用 [{method}] {url}")
    return res

def send_notice(kind, fields):
    titles = {
        "renew_success": "🎉 <b>GreatHost 续期成功</b>",
        "maxed_out": "🈵 <b>GreatHost 已达上限</b>",
        "cooldown": "⏳ <b>GreatHost 还在冷却中</b>",
        "renew_failed": "⚠️ <b>GreatHost 续期未生效</b>",
        "error": "🚨 <b>GreatHost 脚本报错</b>"
    }
    title = titles.get(kind, "‼️ <b>GreatHost 通知</b>")
    body = "\n".join([f"{e} {l}: {v}" for e, l, v in fields])
    msg = f"{title}\n\n{body}\n📅 时间: {now_shanghai()}"
    if TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID:
        try: requests.post(f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage", 
                          data={"chat_id": TELEGRAM_CHAT_ID, "text": msg, "parse_mode": "HTML"}, timeout=5)
        except: pass

# ================= 主流程 =================
def run_task():
    driver = None
    server_id = "未知"
    current_server_name = "未知" # 统一使用此变量名
    login_ip = "Unknown"
    
    try:
        opts = Options()
        opts.add_argument("--headless=new")
        driver = webdriver.Chrome(options=opts, seleniumwire_options={'proxy': {'http': PROXY_URL, 'https': PROXY_URL}} if PROXY_URL else None)
        wait = WebDriverWait(driver, 25)

        # 0. 登入 IP 打印
        try:
            driver.get("https://api.ipify.org?format=json")
            login_ip = json.loads(driver.find_element(By.TAG_NAME, "body").text).get('ip', 'Unknown')
            print(f"🌐 登入 IP: {login_ip}")
        except: pass

        # 1. 登录
        driver.get("https://greathost.es/login")
        wait.until(EC.presence_of_element_located((By.NAME,"email"))).send_keys(EMAIL)
        driver.find_element(By.NAME,"password").send_keys(PASSWORD)
        driver.find_element(By.CSS_SELECTOR,"button[type='submit']").click()
        wait.until(EC.url_contains("/dashboard"))

        # 2. 智能锁定服务器逻辑
        res = fetch_api(driver, "/api/servers")
        server_list = res.get('servers', [])
        
        if not server_list: raise Exception("账号下没有找到任何服务器")

        if TARGET_NAME_CONFIG:
            # 精准匹配
            target_server = next((s for s in server_list if s.get('name') == TARGET_NAME_CONFIG), None)
            if not target_server: raise Exception(f"未找到名称为 '{TARGET_NAME_CONFIG}' 的服务器")
        else:
            # 自动判定
            if len(server_list) == 1:
                target_server = server_list[0]
            else:
                raise Exception(f"账号下存在 {len(server_list)} 个服务器，必须指定 TARGET_NAME")

        server_id = target_server.get('id')
        current_server_name = target_server.get('name') # 获取真实名字
        print(f"✅ 已锁定服务器: {current_server_name}")
        
        # 3. 获取状态
        info = fetch_api(driver, f"/api/servers/{server_id}/information")
        real_status = info.get('status', 'unknown').lower()
        icon, status_name = STATUS_MAP.get(real_status, ["❓", real_status])
        status_disp = f"{icon} {status_name}"

        # 4. 合同预检
        driver.get(f"https://greathost.es/contracts/{server_id}")
        time.sleep(2)
        contract = fetch_api(driver, f"/api/servers/{server_id}/contract")
        before_h = calculate_hours(contract.get('renewalInfo', {}).get('nextRenewalDate'))
        
        btn = wait.until(EC.presence_of_element_located((By.ID, "renew-free-server-btn")))
        if "Wait" in btn.text:
            m = re.search(r"Wait\s+(\d+\s+\w+)", btn.text)
            send_notice("cooldown", [
                ("🖥️", "服务器名称", current_server_name),
                ("⏳", "冷却时间", m.group(1) if m else btn.text),
                ("📊", "当前累计", f"{before_h}h")
            ])
            return

        # 5. 执行续期
        renew_res = fetch_api(driver, f"/api/renewal/contracts/{server_id}/renew-free", method="POST")
        after_h = calculate_hours(renew_res.get('details', {}).get('nextRenewalDate')) or before_h

        # 6. 发送通知 (统一使用 current_server_name)
        if renew_res.get('success') and after_h > before_h:
            send_notice("renew_success", [
                ("🖥️", "服务器名称", current_server_name),
                ("🆔", "ID", f"<code>{server_id}</code>"),
                ("⏰", "增加时间", f"{before_h} ➔ {after_h}h"),
                ("🚀", "运行状态", status_disp),
                ("🌐", "登入 IP", f"<code>{login_ip}</code>")
            ])
        elif "5 d" in str(renew_res.get('message', '')) or (before_h > 108):
            send_notice("maxed_out", [
                ("🖥️", "服务器名称", current_server_name),
                ("🆔", "ID", f"<code>{server_id}</code>"),
                ("⏰", "剩余时间", f"{after_h}h"),
                ("🚀", "运行状态", status_disp),
                ("💡", "提示", "已近120h上限，暂无需续期。"),
                ("🌐", "登入 IP", f"<code>{login_ip}</code>")
            ])
        else:
            send_notice("renew_failed", [("🖥️", "服务器名称", current_server_name), ("💡", "原因", renew_res.get('message','未知错误'))])

    except Exception as e:
        send_notice("error", [("🖥️", "服务器", current_server_name), ("❌", "故障", f"<code>{str(e)[:100]}</code>")])
    finally:
        if driver: driver.quit()

if __name__ == "__main__":
    run_task()
