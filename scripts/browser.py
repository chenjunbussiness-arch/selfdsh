#!/opt/shot/venv/bin/python
"""Drive the resident Chromium over CDP (127.0.0.1:9222). Never launches or closes a browser.

Also manages isolated per-task "lanes": each lane is its own Chromium + Xvfb + x11vnc +
websockify stack under /srv/browser/lanes/<name>/, with its own CDP port, display, profile
and a noVNC watch URL, so parallel tasks cannot close or steal each other's tabs.

Default behaviour (no --lane) is byte-for-byte the same as before: attach to 127.0.0.1:9222.
"""
import base64
import fcntl
import json
import os
import re
import shutil
import signal
import socket
import struct
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime

from playwright.sync_api import sync_playwright

CDP = "http://127.0.0.1:9222"
SERVICES = ["browser-xvfb", "browser", "browser-vnc", "browser-novnc"]

# --- lane layout / allocation -------------------------------------------------
LANE_ROOT = "/srv/browser/lanes"
LANES_LOCK = "/run/browser-lanes.lock"           # global, only for allocate/create/kill
LANE_LOCK_FMT = "/run/browser-lane-%s.lock"      # one exclusive lock per lane
DEFAULT_LOCK = "/run/browser-lane-default.lock"  # default 9222 instance
CDP_PORT_START = 9301
DISPLAY_START = 101
VNC_PORT_START = 5900     # lane display :10n -> 5900+n, never 5900 itself
WEB_PORT_START = 8451     # never 8445 (nginx/noVNC) nor 6080 (default websockify)
CHROME = os.environ.get("BROWSER_LANE_CHROME",
                        "/root/.cache/ms-playwright/chromium-1255/chrome-linux64/chrome")
NOVNC_WEB = "/usr/share/novnc"
WEBSOCKIFY = "/usr/bin/websockify"
LANE_PROXY = os.environ.get("BROWSER_LANE_PROXY", "http://127.0.0.1:17891")
DEFAULT_PROFILE = "/srv/browser/profile"

# --- identity snapshots (browser identity save/load) --------------------------
# 一份快照 = 一个账号在该浏览器里的"登录态"：全部 cookie（browser 级 Storage.getCookies，
# 含 HttpOnly）+ 每个 origin 的 localStorage/sessionStorage。目录 0700、文件 0600，
# 等价于账号凭据。schema 版本用于向前兼容（读到大版本直接报错，不猜语义）。
IDENTITY_ROOT = os.environ.get("BROWSER_IDENTITY_ROOT", "/srv/browser/identities")
IDENTITY_SCHEMA = 1
IDENTITY_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$")
IDENTITY_HOST_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,253}$")
CDP_TIMEOUT = float(os.environ.get("BROWSER_CDP_TIMEOUT", "12"))

# --- isolate presets (lane new --isolate) -------------------------------------
# 每一组都是“真实存在过的 Chrome 稳定版” + 与之自洽的 platform / Accept-Language /
# 时区 / 屏幕尺寸。轮换只在这张表里发生，不拼互不自洽的组合：
#   * UA=Windows -> navigator.platform=Win32；UA=macOS -> MacIntel
#   * en-US 配 America/*，en-GB 配 Europe/London，ja-JP 配 Asia/Tokyo
#   * 屏幕只取 1600x900 / 1536x864 / 1440x900，窗口比屏幕矮 80px（模拟任务栏）
# 版本号均为真实 Chrome 稳定版：131.0.6778 / 130.0.6723 / 129.0.6668。
ISOLATE_PRESETS = [
    {"id": "win131-enUS-NY-1600",
     "ua": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
     "ua_version": "131.0.0.0", "ua_full_version": "131.0.6778.86",
     "platform": "Win32", "ua_platform": "Windows", "platform_version": "15.0.0",
     "architecture": "x86", "bitness": "64",
     "lang": "en-US", "accept_lang": "en-US,en",
     "timezone": "America/New_York", "screen": (1600, 900), "window": (1600, 820)},
    {"id": "win130-enGB-LON-1536",
     "ua": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
     "ua_version": "130.0.0.0", "ua_full_version": "130.0.6723.117",
     "platform": "Win32", "ua_platform": "Windows", "platform_version": "10.0.0",
     "architecture": "x86", "bitness": "64",
     "lang": "en-GB", "accept_lang": "en-GB,en",
     "timezone": "Europe/London", "screen": (1536, 864), "window": (1536, 784)},
    {"id": "mac131-enUS-LA-1440",
     "ua": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
     "ua_version": "131.0.0.0", "ua_full_version": "131.0.6778.86",
     "platform": "MacIntel", "ua_platform": "macOS", "platform_version": "14.6.0",
     "architecture": "x86", "bitness": "64",
     "lang": "en-US", "accept_lang": "en-US,en",
     "timezone": "America/Los_Angeles", "screen": (1440, 900), "window": (1440, 820)},
    {"id": "win129-jaJP-TYO-1440",
     "ua": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
     "ua_version": "129.0.0.0", "ua_full_version": "129.0.6668.100",
     "platform": "Win32", "ua_platform": "Windows", "platform_version": "10.0.0",
     "architecture": "x86", "bitness": "64",
     "lang": "ja-JP", "accept_lang": "ja-JP,ja,en-US,en",
     "timezone": "Asia/Tokyo", "screen": (1440, 900), "window": (1440, 820)},
    {"id": "mac130-enGB-LON-1600",
     "ua": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
     "ua_version": "130.0.0.0", "ua_full_version": "130.0.6723.117",
     "platform": "MacIntel", "ua_platform": "macOS", "platform_version": "14.6.0",
     "architecture": "x86", "bitness": "64",
     "lang": "en-GB", "accept_lang": "en-GB,en",
     "timezone": "Europe/London", "screen": (1600, 900), "window": (1600, 820)},
    {"id": "win131-enUS-CHI-1536",
     "ua": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
     "ua_version": "131.0.0.0", "ua_full_version": "131.0.6778.86",
     "platform": "Win32", "ua_platform": "Windows", "platform_version": "15.0.0",
     "architecture": "x86", "bitness": "64",
     "lang": "en-US", "accept_lang": "en-US,en",
     "timezone": "America/Chicago", "screen": (1536, 864), "window": (1536, 784)},
]
ISO_WINDOW_TASKBAR = 80          # 窗口高度 = 屏幕高度 - 80，模拟有任务栏的桌面
IP_ECHO_URLS = ("https://ifconfig.me/ip", "https://api.ipify.org")
PROXY_PROBE_TIMEOUT = float(os.environ.get("BROWSER_LANE_PROXY_TIMEOUT", "12"))
IPV4_RE = re.compile(r"^\d{1,3}(?:\.\d{1,3}){3}$")

ISO_MEASURE_JS = """(() => ({
  userAgent: navigator.userAgent,
  platform: navigator.platform,
  languages: navigator.languages,
  language: navigator.language,
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  tzOffsetMinutes: new Date().getTimezoneOffset(),
  screen: screen.width + "x" + screen.height,
  screenAvail: screen.availWidth + "x" + screen.availHeight,
  colorDepth: screen.colorDepth,
  outer: window.outerWidth + "x" + window.outerHeight,
  inner: window.innerWidth + "x" + window.innerHeight,
  hardwareConcurrency: navigator.hardwareConcurrency,
  devicePixelRatio: window.devicePixelRatio,
  uaDataBrands: navigator.userAgentData
    ? navigator.userAgentData.brands.map(b => b.brand + "/" + b.version) : null,
  uaDataPlatform: navigator.userAgentData ? navigator.userAgentData.platform : null,
  webglVendor: (() => { try {
    const gl = document.createElement("canvas").getContext("webgl");
    if (!gl) return null;
    const e = gl.getExtension("WEBGL_debug_renderer_info");
    return e ? gl.getParameter(e.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR);
  } catch (e) { return null; } })(),
  webglRenderer: (() => { try {
    const gl = document.createElement("canvas").getContext("webgl");
    if (!gl) return null;
    const e = gl.getExtension("WEBGL_debug_renderer_info");
    return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  } catch (e) { return null; } })(),
  canvasHash: (() => { try {
    const c = document.createElement("canvas"); c.width = 200; c.height = 40;
    const x = c.getContext("2d"); x.textBaseline = "top"; x.font = "14px Arial";
    x.fillStyle = "#f60"; x.fillRect(0, 0, 200, 40);
    x.fillStyle = "#069"; x.fillText("lane-fp-\u6d4b\u8bd5", 2, 2);
    const s = c.toDataURL(); let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(16);
  } catch (e) { return null; } })()
}))()"""
LANE_LOCK_TIMEOUT = float(os.environ.get("BROWSER_LANE_LOCK_TIMEOUT", "180"))
DEFAULT_LOCK_TIMEOUT = float(os.environ.get("BROWSER_DEFAULT_LOCK_TIMEOUT", "30"))
NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$")
SIZE_RE = re.compile(r"^(\d{2,5})x(\d{2,5})$")

USAGE = """usage: browser <command> [args] [--lane <name>]
  open <url>     navigate the active tab (or a new tab if none), wait for load, print URL and title
  shot <path>    screenshot the active tab to <path>
  eval <js>      evaluate JS in the active tab, print the JSON result
  tabs           list open tabs
  cdp-port       print the CDP endpoint
  status         show systemd service states

lane (isolated Chromium + Xvfb + x11vnc + noVNC, one per task):
  lane list                  show every lane: CDP port, display, pid, alive, identity, profile,
                             created, watch URL (isolate lanes also print ua/lang/tz/screen/proxy/exit IP)
  lane new [--name X] [--size 1600x900] [--headless]
           [--isolate [--proxy host:port] [--fp id]] [--profile-preset google]
           [--proxy host:port] [--identity <snapshot>]
                             create a lane (auto name if --name omitted) and wait until CDP is usable
                             --isolate  : per-lane fingerprint preset (real Chrome stable UA +
                                          platform + lang/Accept-Language + TZ + screen size),
                                          rotated across lanes; written to lane.json "isolate"
                             --proxy    : host:port (http/socks5) used by that lane's Chromium,
                                          with or without --isolate. Probed before start and
                                          re-checked via CDP; probe failure = hard error, never a
                                          silent direct fallback
                             --fp       : pin one preset by id or 1..N instead of rotating
                             --identity : after the lane is up, hot-load that identity snapshot
                                          (same code path as "identity load"), recorded in lane.json
                             no --proxy : loud warning, proxy:null, all lanes share the host IP
  lane kill <name>           stop only that lane's processes, keep its profile and metadata

identity (cookie + localStorage snapshot, hot-loaded over CDP, no restart):
  identity save <name> [--lane <lane>] [--force] [--deep]
                             read every cookie (browser-level Storage.getCookies, HttpOnly
                             included) plus localStorage/sessionStorage of every open tab and
                             write /srv/browser/identities/<name>/ (0700 / 0600)
                             --force : overwrite an existing snapshot
                             --deep  : for cookie origins with no open tab, open a throwaway tab
                                       to read their storage (lane targets only, never 9222)
  identity load <name> [--lane <lane>] [--only dom,dom] [--no-tabs]
                             hot-write cookies + storage into a running instance/lane (no restart)
                             --only    : only these domains / suffixes (cookies + origins)
                             --no-tabs : never open throwaway tabs for origins without a live tab
  identity list              snapshots on disk: name, created, cookie count, domains, origins, source
  identity stat [--lane <lane>] [--domain d]
                             read-only cookie counts per domain of a live instance (no values)

global:
  --lane <name>  run open/shot/eval/tabs/identity against that lane instead of 127.0.0.1:9222
  -h, --help     this text

examples:
  browser lane new --name smk
  browser lane new --name iso1 --isolate --proxy 127.0.0.1:17891
  browser lane new --name iso2 --isolate                       # 同 IP 警告，仅隔离指纹
  browser lane new --name plain1 --proxy 127.0.0.1:17891        # 普通 lane 也能配代理
  browser lane new --name id-b --identity xhs                   # 新窗口，登录态搬过来
  browser identity save xhs                                    # 默认实例(9222)，只读 CDP
  browser identity load xhs --lane id-c --only xiaohongshu.com  # 运行中热灌
  browser open --lane smk https://example.com
  browser shot --lane smk /tmp/smk.png
  browser lane kill smk"""


class LaneError(Exception):
    pass


# --- small helpers ------------------------------------------------------------
def now_iso():
    return datetime.now().astimezone().isoformat(timespec="seconds")


def is_alive(pid):
    if not pid:
        return False
    try:
        os.kill(int(pid), 0)
        return True
    except (OSError, ValueError):
        return False


def proc_cmdline(pid):
    try:
        with open("/proc/%d/cmdline" % int(pid), "rb") as f:
            return f.read().replace(b"\0", b" ").decode("utf-8", "replace").strip()
    except (OSError, ValueError):
        return ""


def proc_pgid(pid):
    try:
        with open("/proc/%d/stat" % int(pid), "r") as f:
            rest = f.read().rsplit(")", 1)[1].split()
        return int(rest[2])
    except (OSError, ValueError, IndexError):
        return -1


_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def http_json(url, timeout=0.6):
    try:
        with _OPENER.open(url, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8", "replace"))
    except Exception:
        return None


def port_free(port, host="127.0.0.1"):
    if not port:
        return False
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        s.bind((host, int(port)))
    except OSError:
        return False
    finally:
        s.close()
    # a listener bound to another local address (e.g. 0.0.0.0) still blocks the bind,
    # but double-check with a connect probe for odd cases.
    c = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    c.settimeout(0.2)
    try:
        return c.connect_ex((host, int(port))) != 0
    finally:
        c.close()


def port_open(port, host="127.0.0.1", timeout=0.2):
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(timeout)
    try:
        return s.connect_ex((host, int(port))) == 0
    finally:
        s.close()


def wait_until(fn, timeout, interval=0.25):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if fn():
            return True
        time.sleep(interval)
    return fn()


def cdp_version(port, timeout=0.6):
    if not port:
        return None
    return http_json("http://127.0.0.1:%d/json/version" % int(port), timeout=timeout)


def display_taken(num):
    return (os.path.exists("/tmp/.X11-unix/X%d" % num)
            or os.path.exists("/tmp/.X%d-lock" % num))


def acquire_lock(path, timeout, required, label):
    """flock(LOCK_EX) with a deadline. Returns fd, or None when not required and timed out."""
    fd = os.open(path, os.O_CREAT | os.O_RDWR, 0o666)
    start = time.time()
    warned = False
    while True:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            if warned:
                print("已获得 %s 锁（等待 %.1fs）" % (label, time.time() - start), file=sys.stderr)
            return fd
        except OSError:
            if time.time() - start >= timeout:
                os.close(fd)
                if required:
                    raise LaneError("%s 正被其它任务占用：等待锁 %s 超时（%.0fs）；"
                                    "稍后重试或用 browser lane list 查看" % (label, path, timeout))
                print("warning: 等待 %s 锁超时（%.0fs），本次不加锁继续（默认实例语义不变）"
                      % (label, timeout), file=sys.stderr)
                return None
            if not warned and time.time() - start > 2:
                print("等待 %s 锁（%s）…" % (label, path), file=sys.stderr)
                warned = True
            time.sleep(0.2)


def release_lock(fd):
    if fd is not None:
        try:
            os.close(fd)
        except OSError:
            pass


# --- lane metadata ------------------------------------------------------------
def lane_dir(name):
    return os.path.join(LANE_ROOT, name)


def lane_json_path(name):
    return os.path.join(lane_dir(name), "lane.json")


def save_lane(info):
    path = lane_json_path(info["name"])
    tmp = path + ".tmp"
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(info, f, ensure_ascii=False, indent=2)
        f.write("\n")
    os.replace(tmp, path)


def load_lane(name):
    if not name or not NAME_RE.match(name):
        raise LaneError("非法 lane 名 %r（允许 A-Za-z0-9_.-，首字符非 .-）" % name)
    path = lane_json_path(name)
    if not os.path.isfile(path):
        raise LaneError("lane '%s' 不存在（%s 缺失）；用 browser lane list 查看现有 lane" % (name, path))
    try:
        with open(path, "r", encoding="utf-8") as f:
            info = json.load(f)
    except (OSError, ValueError) as e:
        raise LaneError("lane '%s' 元数据损坏：%s（%s）" % (name, e, path))
    if not isinstance(info, dict) or "cdp_port" not in info:
        raise LaneError("lane '%s' 元数据不完整（缺 cdp_port）：%s" % (name, path))
    info.setdefault("name", name)
    return info


def scan_lanes():
    if not os.path.isdir(LANE_ROOT):
        return []
    out = []
    for name in sorted(os.listdir(LANE_ROOT)):
        d = os.path.join(LANE_ROOT, name)
        if not os.path.isdir(d):
            continue
        try:
            out.append((name, load_lane(name), None))
        except LaneError as e:
            out.append((name, None, str(e)))
    return out


def lane_state(info):
    """alive only if that lane's own Chromium answers CDP.

    Lanes may reuse each other's ports after a kill, so a live CDP port alone is not
    proof of identity: the recorded chromium pid must still exist *and* still be ours.
    """
    pid = info.get("chromium_pid")
    if not is_alive(pid) or not _owned("chromium", info, pid):
        return "dead"
    return "alive" if cdp_version(info.get("cdp_port")) else "stale"


def watch_url(info):
    if info.get("headless"):
        return None
    web = info.get("web_port")
    if not web:
        return None
    return "http://127.0.0.1:%d/vnc.html?autoconnect=1&resize=remote&path=websockify" % int(web)


# --- lane lifecycle -----------------------------------------------------------
def _pick_port(preferred, used):
    port = preferred
    limit = preferred + 400
    while port < limit:
        if port not in used and port_free(port):
            return port
        port += 1
    raise LaneError("找不到可用端口（从 %d 起搜索 %d 个都占用）" % (preferred, limit - preferred))


def _pick_display():
    n = DISPLAY_START
    while n < DISPLAY_START + 400:
        if not display_taken(n):
            return n
        n += 1
    raise LaneError("找不到可用 X display（从 :%d 起搜索失败）" % DISPLAY_START)


def _used_ports():
    """Ports still owned by running lanes. Killed/dead lanes release theirs (bind test is the backstop)."""
    used = set()
    for _, info, _ in scan_lanes():
        if not info:
            continue
        if info.get("state") == "killed":
            continue
        if not is_alive(info.get("chromium_pid")) and lane_state(info) != "alive":
            continue
        for key in ("cdp_port", "vnc_port", "web_port"):
            if info.get(key):
                used.add(int(info[key]))
    return used


def _used_names():
    return {name for name, _, _ in scan_lanes()}


def _new_name():
    for i in range(1, 1000):
        name = "lane-%d" % i
        if name not in _used_names():
            return name
    raise LaneError("自动生成 lane 名失败")


def _spawn(argv, log_path, env=None):
    log = open(log_path, "ab", buffering=0)
    try:
        p = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=log,
                             stderr=subprocess.STDOUT, start_new_session=True,
                             close_fds=True, env=env)
    finally:
        log.close()
    return p


def _log_tail(path, n=4):
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            lines = [l.rstrip() for l in f.readlines() if l.strip()]
        return " | ".join(lines[-n:])
    except OSError:
        return ""


# --- isolate helpers ----------------------------------------------------------
def preset_by_id(preset_id):
    for p in ISOLATE_PRESETS:
        if p["id"] == preset_id:
            return p
    return None


def pick_preset(fp, used_counts):
    """Pin one preset with --fp, else rotate to the least-used preset (ties: lowest index)."""
    if fp:
        p = preset_by_id(fp)
        if p:
            return p
        if str(fp).isdigit() and 1 <= int(fp) <= len(ISOLATE_PRESETS):
            return ISOLATE_PRESETS[int(fp) - 1]
        raise LaneError("--fp 只接受候选表 id 或序号 1..%d（id 见 W4-ISOLATE.md）"
                        % len(ISOLATE_PRESETS))
    best = None
    for idx, p in enumerate(ISOLATE_PRESETS):
        count = used_counts.get(p["id"], 0)
        if best is None or count < best[0]:
            best = (count, idx, p)
    return best[2]


def used_preset_counts():
    counts = {}
    for _, info, _ in scan_lanes():
        if not info:
            continue
        iso = info.get("isolate") or {}
        pid = iso.get("preset")
        if pid:
            counts[pid] = counts.get(pid, 0) + 1
    return counts


def parse_proxy(spec):
    """host:port / http://host:port / socks5://host:port -> (host, port, url)."""
    s = (spec or "").strip()
    if not s:
        raise LaneError("--proxy 需要 host:port，例如 127.0.0.1:17891")
    if "://" not in s:
        s = "http://" + s
    m = re.match(r"^(https?|socks5)://([A-Za-z0-9_.\-]+):(\d{1,5})$", s)
    if not m:
        raise LaneError("--proxy 只支持 [http://|https://|socks5://]host:port，收到 %r" % spec)
    scheme, host, port = m.group(1), m.group(2), int(m.group(3))
    if not 1 <= port <= 65535:
        raise LaneError("--proxy 端口越界：%r" % spec)
    return host, port, "%s://%s:%d" % (scheme, host, port)


def proxy_tcp_ok(host, port, timeout=4.0):
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(timeout)
    try:
        return s.connect_ex((host, int(port))) == 0
    finally:
        s.close()


def _curl(args, timeout):
    try:
        r = subprocess.run(["curl", "-q", "-sS"] + args, capture_output=True, text=True,
                           timeout=timeout + 6)
        return r.returncode, (r.stdout or "").strip(), (r.stderr or "").strip()
    except FileNotFoundError:
        return 127, "", "curl 不存在"
    except subprocess.TimeoutExpired:
        return 28, "", "curl 超时"


def fetch_exit_ip(proxy_url=None):
    """Egress IP via that proxy (or direct when proxy_url is None); never falls back."""
    last = ""
    for url in IP_ECHO_URLS:
        args = ["--max-time", str(int(PROXY_PROBE_TIMEOUT))]
        args += (["-x", proxy_url] if proxy_url else ["--noproxy", "*"])
        rc, out, err = _curl(args + [url], PROXY_PROBE_TIMEOUT)
        if rc == 0:
            tok = out.split()[0] if out.split() else ""
            if IPV4_RE.match(tok):
                return tok, None, url
            last = "返回内容不是 IP：%r" % out[:80]
        else:
            last = "curl exit %d: %s" % (rc, err or out[:160])
    return None, last, None


def ua_metadata(p):
    major = p["ua_version"].split(".")[0]
    return {
        "brands": [{"brand": "Chromium", "version": major},
                   {"brand": "Google Chrome", "version": major},
                   {"brand": "Not_A Brand", "version": "24"}],
        "fullVersion": p["ua_full_version"],
        "fullVersionList": [{"brand": "Chromium", "version": p["ua_full_version"]},
                            {"brand": "Google Chrome", "version": p["ua_full_version"]},
                            {"brand": "Not_A Brand", "version": "24.0.0.0"}],
        "platform": p["ua_platform"],
        "platformVersion": p["platform_version"],
        "architecture": p["architecture"],
        "model": "",
        "mobile": False,
        "bitness": p["bitness"],
        "wow64": False,
    }


def iso_attach(ctx, page, preset):
    """Attach a CDP session and apply UA/client-hints/platform/timezone to that target.

    Chrome resets Emulation overrides when the DevTools session detaches, so the caller
    must keep the returned session open for as long as the override has to be visible,
    then detach it in a finally block.
    """
    warns = []
    cdp = ctx.new_cdp_session(page)
    try:
        try:
            cdp.send("Emulation.setUserAgentOverride",
                     {"userAgent": preset["ua"],
                      "acceptLanguage": preset["accept_lang"],
                      "platform": preset["platform"],
                      "userAgentMetadata": ua_metadata(preset)})
        except Exception as e:
            warns.append("setUserAgentOverride(userAgentMetadata) 被拒：%s；"
                         "退回只改 UA/platform（Sec-CH-UA 会暴露真实版本）" % str(e).splitlines()[0][:160])
            cdp.send("Emulation.setUserAgentOverride",
                     {"userAgent": preset["ua"],
                      "acceptLanguage": preset["accept_lang"],
                      "platform": preset["platform"]})
        cdp.send("Emulation.setTimezoneOverride", {"timezoneId": preset["timezone"]})
    except Exception:
        try:
            cdp.detach()
        except Exception:
            pass
        raise
    return cdp, warns


def strip_qvalues(header):
    """'en-US,en;q=0.9' -> 'en-US,en'（Chrome 自己补 q 值，比较时只比语言序列）."""
    parts = [p.split(";")[0].strip() for p in (header or "").split(",")]
    return ",".join([p for p in parts if p])


def zone_offset_minutes(tz):
    """JS getTimezoneOffset() equivalent (minutes behind UTC), or None if tzdata missing."""
    try:
        from zoneinfo import ZoneInfo
        off = datetime.now(ZoneInfo(tz)).utcoffset()
        if off is None:
            return None
        return int(-off.total_seconds() // 60)
    except Exception:
        return None


def isolate_finalize(info, preset, proxy, proxy_url, probe_ip, probe_endpoint, direct_ip):
    """Apply overrides to the lane's first target, measure them, verify exit IP, then record."""
    iso = {
        "enabled": True,
        "preset": preset["id"],
        "ua": preset["ua"],
        "ua_version": preset["ua_version"],
        "platform": preset["platform"],
        "lang": preset["lang"],
        "accept_lang": preset["accept_lang"],
        "timezone": preset["timezone"],
        "screen": "%dx%d" % preset["screen"],
        "window": info.get("window_size") or info["size"],
        "proxy": proxy,
        "proxy_url": proxy_url,
        "proxy_probe_exit_ip": probe_ip,
        "proxy_probe_endpoint": probe_endpoint,
        "direct_exit_ip": direct_ip,
        "exit_ip": None,
        "exit_ip_match": None,
        "checks": {},
        "effective": {},
        "warnings": [],
    }
    if info.get("headless"):
        iso["screen_note"] = ("headless：没有 Xvfb，screen.width/height 只由 --window-size 决定，"
                              "预设屏幕尺寸不生效")
    with sync_playwright() as pw:
        browser = pw.chromium.connect_over_cdp(info["cdp_url"])
        ctx = browser.contexts[0]
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        cdp, warns = iso_attach(ctx, page, preset)
        iso["warnings"] += warns
        wire = {}

        def _on_extra(params):
            low = {str(k).lower(): v for k, v in (params.get("headers") or {}).items()}
            for k in ("user-agent", "accept-language", "sec-ch-ua", "sec-ch-ua-platform"):
                if low.get(k):
                    wire[k] = low[k]

        try:
            try:
                cdp.send("Network.enable")
                cdp.on("Network.requestWillBeSentExtraInfo", _on_extra)
            except Exception as e:
                iso["warnings"].append("Network.enable 失败，跳过请求头核验：%s"
                                       % str(e).splitlines()[0][:120])
            # 走 https 页面：既有出口 IP，也让 navigator.userAgentData（需要安全上下文）可用
            try:
                page.goto(IP_ECHO_URLS[0], wait_until="domcontentloaded", timeout=25000)
                txt = (page.evaluate("document.body ? document.body.innerText : ''") or "").strip()
                tok = txt.split()[0] if txt.split() else ""
                if IPV4_RE.match(tok):
                    iso["exit_ip"] = tok
                else:
                    iso["warnings"].append("CDP 出口 IP 复检失败：页面内容不是 IP（%r）" % txt[:80])
            except Exception as e:
                iso["warnings"].append("CDP 出口 IP 复检失败：%s"
                                       % str(e).splitlines()[0][:160])
            try:
                iso["effective"] = page.evaluate(ISO_MEASURE_JS)
            except Exception as e:
                iso["warnings"].append("指纹实测失败：%s" % str(e).splitlines()[0][:160])
        finally:
            try:
                page.goto("about:blank", wait_until="load", timeout=15000)
            except Exception:
                pass
            try:
                cdp.detach()
            except Exception:
                pass
    iso["wire"] = wire

    eff = iso["effective"]
    checks = {
        "ua": eff.get("userAgent") == preset["ua"],
        "platform": eff.get("platform") == preset["platform"],
        "lang": (eff.get("languages") or [None])[0] == preset["lang"],
        "timezone": eff.get("timezone") == preset["timezone"],
    }
    want_off = zone_offset_minutes(preset["timezone"])
    if want_off is not None:
        checks["tz_offset"] = eff.get("tzOffsetMinutes") == want_off
        iso["expected_tz_offset"] = want_off
    if not info.get("headless"):
        checks["screen"] = eff.get("screen") == iso["screen"]
    if wire.get("user-agent"):
        checks["header_ua"] = wire["user-agent"] == preset["ua"]
    if wire.get("accept-language"):
        iso["accept_lang_header"] = wire["accept-language"]
        checks["header_accept_language"] = (
            strip_qvalues(wire["accept-language"]) == preset["accept_lang"])
    if wire.get("sec-ch-ua"):
        major = preset["ua_version"].split(".")[0]
        checks["sec_ch_ua_version"] = ('"%s"' % major) in wire["sec-ch-ua"].replace("v=", "")
    if wire.get("sec-ch-ua-platform"):
        checks["sec_ch_ua_platform"] = preset["ua_platform"] in wire["sec-ch-ua-platform"]
    iso["checks"] = checks
    got = dict(eff)
    got.update({"header_ua": wire.get("user-agent"),
                "header_accept_language": wire.get("accept-language"),
                "sec_ch_ua_version": wire.get("sec-ch-ua"),
                "sec_ch_ua_platform": wire.get("sec-ch-ua-platform")})
    for key, ok in checks.items():
        if not ok:
            iso["warnings"].append("实测 %s 与预设不一致（实测 %r，预设 %r）"
                                   % (key, got.get(key), iso.get(key) or preset.get(key)))

    if probe_ip:
        if iso["exit_ip"] is None:
            iso["warnings"].append("代理探测出口 %s，但 lane 内 CDP 复检没取到 IP" % probe_ip)
        elif iso["exit_ip"] != probe_ip:
            iso["exit_ip_match"] = False
            iso["warnings"].append("出口 IP 不一致：探测 %s，lane 实测 %s"
                                   % (probe_ip, iso["exit_ip"]))
        else:
            iso["exit_ip_match"] = True
        if direct_ip and iso["exit_ip"] == direct_ip and probe_ip != direct_ip:
            raise LaneError("代理被绕过：lane 实测出口 %s == 本机直连出口 %s（探测代理出口 %s）；"
                            "拒绝保留该 lane，绝不静默回落直连"
                            % (iso["exit_ip"], direct_ip, probe_ip))
    return iso


def _owned(role, info, pid):
    """True only when pid is alive and provably one of this lane's own processes."""
    if not is_alive(pid):
        return False
    cmd = proc_cmdline(pid)
    if not cmd:
        return False
    # hard guards: never touch the default instance
    if DEFAULT_PROFILE in cmd or "remote-debugging-port=9222" in cmd or info.get("display") == ":99":
        return False
    if "%s_pgid" % role in info and proc_pgid(pid) != int(info["%s_pgid" % role]):
        return False
    toks = cmd.split()
    if role == "chromium":
        return ("--remote-debugging-port=%s" % info.get("cdp_port")) in cmd and \
               ("--user-data-dir=%s" % info.get("profile")) in cmd
    if role == "xvfb":
        return "Xvfb" in cmd and info.get("display") in toks
    if role == "x11vnc":
        return "x11vnc" in cmd and info.get("display") in toks
    if role == "websockify":
        return "websockify" in cmd and \
               ("127.0.0.1:%s" % info.get("web_port")) in cmd and \
               ("127.0.0.1:%s" % info.get("vnc_port")) in cmd
    return False


def _terminate(role, info, quiet=False):
    pid = int(info.get("%s_pid" % role) or 0)
    if not pid:
        return "无"
    if not is_alive(pid):
        return "已退出"
    if not _owned(role, info, pid):
        return "跳过（PID %d 归属校验失败，不杀）" % pid
    pgid = int(info.get("%s_pgid" % role) or proc_pgid(pid) or pid)
    try:
        os.killpg(pgid, signal.SIGTERM)
    except OSError:
        try:
            os.kill(pid, signal.SIGTERM)
        except OSError:
            pass
    if not wait_until(lambda: not is_alive(pid), 6.0):
        try:
            os.killpg(pgid, signal.SIGKILL)
        except OSError:
            pass
        wait_until(lambda: not is_alive(pid), 3.0)
    if not quiet:
        print("  %-11s pid %-7d pgid %-7d 已停止" % (role, pid, pgid))
    return "已停止"


def _xvfb_on_display(display):
    """pid of any live Xvfb serving that display, else 0."""
    for pid in os.listdir("/proc"):
        if not pid.isdigit():
            continue
        cmd = proc_cmdline(pid)
        if "Xvfb" in cmd and display in cmd.split():
            return int(pid)
    return 0


def _clean_x_locks(info):
    """Remove the /.X<n>-lock and socket only for this lane's own display (never :99)."""
    disp = info.get("display") or ""
    if not disp.startswith(":") or disp == ":99":
        return []
    try:
        n = int(disp[1:])
    except ValueError:
        return []
    if n < 100:
        return []
    removed = []
    if is_alive(info.get("xvfb_pid")):
        return removed
    owner = _xvfb_on_display(disp)
    if owner and owner != int(info.get("xvfb_pid") or 0):
        return removed  # display reused by another lane; leave its lock/socket alone
    lock = "/tmp/.X%d-lock" % n
    if os.path.exists(lock):
        try:
            with open(lock, "r") as f:
                holder = f.read().strip()
        except OSError:
            holder = ""
        if not holder or not is_alive(holder) or int(holder or 0) == int(info.get("xvfb_pid") or 0):
            try:
                os.unlink(lock)
                removed.append(lock)
            except OSError:
                pass
    sock_path = "/tmp/.X11-unix/X%d" % n
    if os.path.exists(sock_path) and not _xvfb_on_display(disp):
        try:
            os.unlink(sock_path)
            removed.append(sock_path)
        except OSError:
            pass
    return removed


# --- identity snapshots: raw CDP client --------------------------------------
# Playwright 的 connect_over_cdp 会 attach 到每一个 target，只要有一个渲染进程卡住就整体
# 超时（本机高负载时实测会挂 30s+）。身份快照只需要两个很窄的 CDP 调用，所以这里直接
# 说 WebSocket 协议：连 browser target 读/写 cookie，连具体 page target 读写 storage。
# 好处：不碰别人的标签页、不需要重启、每一步都有独立超时。
STORAGE_READ_JS = """(() => {
  const dump = (st) => { const out = {}; try { for (let i = 0; i < st.length; i++) {
      const k = st.key(i); out[k] = st.getItem(k); } } catch (e) {}
    return out; };
  let local = null, session = null, err = null;
  try { local = dump(window.localStorage); } catch (e) { err = String(e); }
  try { session = dump(window.sessionStorage); } catch (e) { err = (err ? err + "; " : "") + String(e); }
  return { origin: location.origin, href: location.href, local: local, session: session, error: err };
})()"""

# 先 clear 再写：避免旧账号残留键和新身份混在一起（混号比丢键更危险）。
STORAGE_WRITE_JS = """(function (data) {
  const res = { origin: location.origin, local: 0, session: 0, error: null };
  try {
    localStorage.clear();
    for (const k in data.local) { if (Object.prototype.hasOwnProperty.call(data.local, k)) {
      localStorage.setItem(k, data.local[k]); res.local++; } }
  } catch (e) { res.error = String(e); }
  try {
    sessionStorage.clear();
    for (const k in data.session) { if (Object.prototype.hasOwnProperty.call(data.session, k)) {
      sessionStorage.setItem(k, data.session[k]); res.session++; } }
  } catch (e) { res.error = (res.error ? res.error + "; " : "") + String(e); }
  return res;
})(%s)"""


class CdpError(Exception):
    pass


class CdpWs:
    """Minimal CDP WebSocket client (stdlib only, text frames, bounded timeouts)."""

    def __init__(self, ws_url, timeout=CDP_TIMEOUT, label=""):
        self.url = ws_url
        self.label = label
        self.timeout = float(timeout)
        self._id = 0
        self._buf = b""
        self._closed = False
        self.sock = self._connect(ws_url)

    @staticmethod
    def _split_url(url):
        m = re.match(r"^ws://([^/:]+)(?::(\d+))?(/.*)$", url or "")
        if not m:
            raise CdpError("无法解析 WebSocket URL：%r" % (url,))
        return m.group(1), int(m.group(2) or 80), m.group(3)

    def _connect(self, url):
        host, port, path = self._split_url(url)
        try:
            s = socket.create_connection((host, port), timeout=self.timeout)
        except OSError as e:
            raise CdpError("连接 CDP %s:%d 失败：%s" % (host, port, e))
        s.settimeout(self.timeout)
        key = base64.b64encode(os.urandom(16)).decode()
        req = ("GET %s HTTP/1.1\r\nHost: %s:%d\r\nUpgrade: websocket\r\n"
               "Connection: Upgrade\r\nSec-WebSocket-Key: %s\r\n"
               "Sec-WebSocket-Version: 13\r\n\r\n" % (path, host, port, key))
        try:
            s.sendall(req.encode())
            buf = b""
            while b"\r\n\r\n" not in buf:
                chunk = s.recv(4096)
                if not chunk:
                    raise CdpError("WebSocket 握手失败：连接被关闭")
                buf += chunk
                if len(buf) > 65536:
                    raise CdpError("WebSocket 握手失败：响应头过大")
        except socket.timeout:
            s.close()
            raise CdpError("WebSocket 握手超时（%.0fs）" % self.timeout)
        except OSError as e:
            s.close()
            raise CdpError("WebSocket 握手失败：%s" % e)
        head, rest = buf.split(b"\r\n\r\n", 1)
        status = head.split(b"\r\n", 1)[0].decode("latin-1", "replace")
        if " 101 " not in status + " ":
            s.close()
            raise CdpError("WebSocket 握手被拒：%s" % status)
        self._buf = rest
        return s

    def _send_frame(self, opcode, payload):
        if self._closed:
            raise CdpError("CDP 连接已关闭")
        mask = os.urandom(4)
        n = len(payload)
        hdr = bytearray([0x80 | opcode])
        if n < 126:
            hdr.append(0x80 | n)
        elif n < 65536:
            hdr.append(0x80 | 126)
            hdr += struct.pack(">H", n)
        else:
            hdr.append(0x80 | 127)
            hdr += struct.pack(">Q", n)
        hdr += mask
        if n:
            pad = (mask * (n // 4 + 1))[:n]
            payload = (int.from_bytes(payload, "big") ^ int.from_bytes(pad, "big")).to_bytes(n, "big")
        self.sock.sendall(bytes(hdr) + payload)

    def _recv_exact(self, n):
        while len(self._buf) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise CdpError("CDP 连接被对端关闭")
            self._buf += chunk
        out, self._buf = self._buf[:n], self._buf[n:]
        return out

    def _recv_message(self):
        chunks = []
        while True:
            b1, b2 = self._recv_exact(2)
            fin, opcode = b1 & 0x80, b1 & 0x0F
            ln = b2 & 0x7F
            if ln == 126:
                ln = struct.unpack(">H", self._recv_exact(2))[0]
            elif ln == 127:
                ln = struct.unpack(">Q", self._recv_exact(8))[0]
            if b2 & 0x80:  # server must not mask; tolerate anyway
                mk = self._recv_exact(4)
                data = self._recv_exact(ln)
                data = bytes(b ^ mk[i % 4] for i, b in enumerate(data))
            else:
                data = self._recv_exact(ln)
            if opcode == 0x9:      # ping
                self._send_frame(0xA, data)
                continue
            if opcode == 0xA:      # pong
                continue
            if opcode == 0x8:
                self._closed = True
                raise CdpError("对端关闭 CDP WebSocket")
            chunks.append(data)
            if fin:
                return b"".join(chunks)

    def call(self, method, params=None, timeout=None):
        if self._closed:
            raise CdpError("CDP 连接已关闭")
        self._id += 1
        mid = self._id
        tmo = float(timeout or self.timeout)
        try:
            self.sock.settimeout(tmo)
            self._send_frame(0x1, json.dumps({"id": mid, "method": method,
                                              "params": params or {}}).encode())
        except socket.timeout:
            raise CdpError("%s 发送超时（%.0fs）" % (method, tmo))
        except OSError as e:
            raise CdpError("%s 发送失败：%s" % (method, e))
        deadline = time.time() + tmo
        while True:
            left = deadline - time.time()
            if left <= 0:
                raise CdpError("%s 超时（%.0fs）%s" % (method, tmo, " [%s]" % self.label if self.label else ""))
            try:
                self.sock.settimeout(max(0.2, left))
                raw = self._recv_message()
            except socket.timeout:
                raise CdpError("%s 超时（%.0fs）" % (method, tmo))
            except OSError as e:
                self._closed = True
                raise CdpError("%s 读取失败：%s" % (method, e))
            try:
                msg = json.loads(raw.decode("utf-8", "replace"))
            except ValueError:
                continue
            if msg.get("id") != mid:
                continue  # 事件/别人的响应，忽略
            if "error" in msg:
                err = msg["error"] or {}
                raise CdpError("%s 被 CDP 拒绝：%s" % (method, err.get("message") or err))
            return msg.get("result") or {}

    def close(self):
        if self._closed:
            return
        try:
            self._send_frame(0x8, b"")
        except Exception:
            pass
        self._closed = True
        try:
            self.sock.close()
        except Exception:
            pass


def cdp_browser_ws(endpoint, timeout=CDP_TIMEOUT, attempts=3):
    """(browser websocket url, /json/version payload) for a CDP HTTP endpoint.

    /json/* 由浏览器主线程处理，本机高负载时会短暂不响应；重试几次再判定"不可用"，
    避免把一次抖动当成实例已死。
    """
    last = None
    for n in range(attempts):
        ver = http_json(endpoint.rstrip("/") + "/json/version", timeout=timeout)
        if ver and ver.get("webSocketDebuggerUrl"):
            return ver["webSocketDebuggerUrl"], ver
        last = ver
        if n + 1 < attempts:
            time.sleep(0.5 + n)
    raise CdpError("%s/json/version 无响应（浏览器可能正忙或未启动；重试 %d 次）"
                   % (endpoint.rstrip("/"), attempts))


def cdp_targets(endpoint, timeout=CDP_TIMEOUT):
    data = http_json(endpoint.rstrip("/") + "/json/list", timeout=timeout)
    if data is None:
        raise CdpError("%s/json/list 无响应" % endpoint.rstrip("/"))
    return data


def cdp_eval(tws, expression, timeout=CDP_TIMEOUT):
    """Runtime.evaluate on a page target; returns the JS value (by value)."""
    ws = CdpWs(tws, timeout=timeout, label="page")
    try:
        res = ws.call("Runtime.evaluate", {"expression": expression,
                                           "returnByValue": True,
                                           "awaitPromise": False}, timeout=timeout)
    finally:
        ws.close()
    if res.get("exceptionDetails"):
        det = res["exceptionDetails"]
        desc = (det.get("exception") or {}).get("description") or det.get("text") or "JS 异常"
        raise CdpError(str(desc).splitlines()[0][:180])
    return (res.get("result") or {}).get("value")


def cdp_create_target(bws, endpoint, url, timeout=CDP_TIMEOUT):
    """Open a throwaway tab in that instance; returns (targetId, page ws url)."""
    res = bws.call("Target.createTarget", {"url": url}, timeout=timeout)
    tid = res.get("targetId")
    if not tid:
        raise CdpError("Target.createTarget 没有返回 targetId")
    deadline = time.time() + timeout
    while time.time() < deadline:
        for t in cdp_targets(endpoint, timeout=4) or []:
            if t.get("id") == tid and t.get("webSocketDebuggerUrl"):
                return tid, t["webSocketDebuggerUrl"]
        time.sleep(0.2)
    return tid, None


def cdp_probe_exit_ip(endpoint, timeout=35):
    """Egress IP measured *inside* that Chromium via a throwaway tab (no direct fallback)."""
    bws = CdpWs(cdp_browser_ws(endpoint, timeout=8)[0], timeout=timeout, label="browser")
    tid = None
    try:
        tid, tws = cdp_create_target(bws, endpoint, IP_ECHO_URLS[0], timeout=timeout)
        if not tws:
            return None, "新标签页没有 WebSocket URL"
        deadline = time.time() + timeout
        last = ""
        while time.time() < deadline:
            try:
                txt = cdp_eval(tws, "document.body ? document.body.innerText : ''", timeout=6) or ""
            except CdpError as e:
                txt, last = "", str(e)
            tok = txt.split()[0] if txt.split() else ""
            if IPV4_RE.match(tok):
                return tok, None
            time.sleep(0.5)
        return None, last or "页面内容里没有 IPv4"
    finally:
        if tid:
            try:
                bws.call("Target.closeTarget", {"targetId": tid}, timeout=5)
            except Exception:
                pass
        bws.close()


# --- identity snapshots: paths / cookies / storage ----------------------------
def identity_dir(name):
    return os.path.join(IDENTITY_ROOT, name)


def identity_path(name, *parts):
    return os.path.join(identity_dir(name), *parts)


def check_identity_name(name):
    if not name or not IDENTITY_NAME_RE.match(name):
        raise LaneError("非法身份名 %r（允许 A-Za-z0-9_.-，首字符非 .-，最长 64）" % (name,))
    return name


def _mkdir_private(path):
    os.makedirs(path, mode=0o700, exist_ok=True)
    try:
        os.chmod(path, 0o700)
    except OSError:
        pass


def _write_private(path, data):
    tmp = path + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            if not isinstance(data, str):
                json.dump(data, f, ensure_ascii=False, indent=2)
                f.write("\n")
            else:
                f.write(data)
    finally:
        try:
            os.chmod(tmp, 0o600)
        except OSError:
            pass
    os.replace(tmp, path)


def _read_json(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def url_origin(url):
    """'https://a.b/c?d' -> 'https://a.b'（只认 http/https，其它返回 None）."""
    try:
        p = urllib.parse.urlsplit(url or "")
    except ValueError:
        return None
    if p.scheme not in ("http", "https") or not p.hostname:
        return None
    host = p.hostname.lower()
    if p.port:
        return "%s://%s:%d" % (p.scheme, host, p.port)
    return "%s://%s" % (p.scheme, host)


def origin_host(origin):
    try:
        return (urllib.parse.urlsplit(origin).hostname or "").lower()
    except ValueError:
        return ""


def origin_filename(origin):
    return re.sub(r"[^A-Za-z0-9._-]", "_", origin.replace("://", "_")) + ".json"


def _cookie_host(c):
    return (c.get("domain") or "").lstrip(".").lower()


def _host_matches(host, specs):
    host = (host or "").lstrip(".").lower()
    return any(host == s or host.endswith("." + s) for s in specs)


def parse_only(spec):
    """'a.com, .b.com' -> ['a.com', 'b.com']；非法值直接报错。"""
    if not spec:
        return None
    out = []
    for raw in spec.split(","):
        s = raw.strip().lstrip(".").lower()
        if not s:
            continue
        if not IDENTITY_HOST_RE.match(s):
            raise LaneError("--only 只接受域名/后缀（逗号分隔），%r 不合法" % raw)
        out.append(s)
    return out or None


def _norm_cookie(c):
    out = {"name": c.get("name", ""), "value": c.get("value", ""),
           "domain": c.get("domain", ""), "path": c.get("path", "/")}
    exp = c.get("expires")
    out["expires"] = float(exp) if isinstance(exp, (int, float)) else -1.0
    out["httpOnly"] = bool(c.get("httpOnly"))
    out["secure"] = bool(c.get("secure"))
    if c.get("sameSite") in ("Strict", "Lax", "None"):
        out["sameSite"] = c["sameSite"]
    pk = c.get("partitionKey")
    if isinstance(pk, dict) and pk.get("topLevelSite"):
        out["partitionKey"] = {"topLevelSite": pk["topLevelSite"],
                               "hasCrossSiteAncestor": bool(pk.get("hasCrossSiteAncestor"))}
    if c.get("priority") in ("Low", "Medium", "High"):
        out["priority"] = c["priority"]
    return out


def _cookie_param(c):
    """CookieParam for Storage.setCookies (only fields Chrome accepts on write)."""
    p = {"name": c.get("name", ""), "value": c.get("value", ""),
         "domain": c.get("domain", ""), "path": c.get("path", "/"),
         "secure": bool(c.get("secure")), "httpOnly": bool(c.get("httpOnly"))}
    exp = c.get("expires")
    if isinstance(exp, (int, float)) and exp > 0:
        p["expires"] = float(exp)
    if c.get("sameSite") in ("Strict", "Lax", "None"):
        p["sameSite"] = c["sameSite"]
    if c.get("priority"):
        p["priority"] = c["priority"]
    if c.get("partitionKey"):
        p["partitionKey"] = c["partitionKey"]
    return p


def _cookie_alive(c):
    exp = c.get("expires")
    return not (isinstance(exp, (int, float)) and 0 <= exp <= time.time())


def _ckey(c):
    pk = c.get("partitionKey") or {}
    return (c.get("name", ""), (c.get("domain") or "").lstrip(".").lower(),
            c.get("path", "/"), pk.get("topLevelSite") or "")


def identity_target(lane_name):
    """(lane_info|None, endpoint, label, is_default) for a live instance; hard-fails when dead."""
    if lane_name:
        info = load_lane(lane_name)
        state = lane_state(info)
        if state != "alive":
            raise LaneError("lane '%s' 不可用（状态 %s，CDP 127.0.0.1:%s）。identity 热灌只对"
                            "运行中的实例有效：先 browser lane new --name %s ... 再灌，"
                            "或用 browser lane list 看现场"
                            % (lane_name, state, info.get("cdp_port"), lane_name))
        return info, "http://127.0.0.1:%d" % int(info["cdp_port"]), "lane %s" % lane_name, False
    if cdp_version(9222, timeout=CDP_TIMEOUT) is None:
        raise LaneError("默认实例 127.0.0.1:9222 无响应（或正忙，/json/version 连续超时）："
                        "身份快照需要运行中的浏览器；本工具不重启实例，稍后重试")
    return None, CDP, "默认实例(9222)", True


def _identity_lock(lane_name, is_default, label):
    if is_default:
        return acquire_lock(DEFAULT_LOCK, DEFAULT_LOCK_TIMEOUT, False, label)
    return acquire_lock(LANE_LOCK_FMT % lane_name, LANE_LOCK_TIMEOUT, True, "lane %s" % lane_name)


def _read_page_storage(endpoint, timeout=6):
    """{origin: {local, session, href, tabs}} from every open http(s) tab (per-origin merge).

    并发读：一台机器上常有几个标签页的渲染进程正忙，串行读会把单个 8s 超时累加成分钟级；
    并发 + 每个 target 独立超时，最坏情况只等一个 timeout。
    """
    out = {}
    targets = cdp_targets(endpoint, timeout=timeout) or []
    pages = [t for t in targets if t.get("type") == "page"
             and url_origin(t.get("url")) and t.get("webSocketDebuggerUrl")]
    fails = []

    def _one(t):
        origin = url_origin(t["url"])
        try:
            data = cdp_eval(t["webSocketDebuggerUrl"], STORAGE_READ_JS, timeout=timeout)
            return origin, data, None
        except CdpError as e:
            return origin, None, str(e)[:120]

    with ThreadPoolExecutor(max_workers=8) as pool:
        for origin, data, err in pool.map(_one, pages[:24]):
            if err:
                fails.append((origin, err))
                continue
            if not isinstance(data, dict):
                continue
            cur = out.setdefault(origin, {"local": {}, "session": {}, "href": data.get("href"),
                                          "tabs": 0, "error": None})
            cur["tabs"] += 1
            cur["local"].update(data.get("local") or {})
            cur["session"].update(data.get("session") or {})
            if data.get("error"):
                cur["error"] = data["error"]
    return out, fails


def _print_cookie_domains(counts, limit=24):
    items = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))
    shown = ", ".join("%s(%d)" % (d, n) for d, n in items[:limit])
    if len(items) > limit:
        shown += ", … 另 %d 个域名" % (len(items) - limit)
    return shown or "（无）"


def identity_save(name, lane_name=None, force=False, deep=False):
    check_identity_name(name)
    dest = identity_dir(name)
    if os.path.exists(dest) and not force:
        raise LaneError("身份 '%s' 已存在（%s）；用 --force 覆盖，或换个名字" % (name, dest))
    lane_info, endpoint, label, is_default = identity_target(lane_name)
    t0 = time.time()
    lock_fd = _identity_lock(lane_name, is_default, label)
    try:
        bws_url, ver = cdp_browser_ws(endpoint, timeout=CDP_TIMEOUT)
        bws = CdpWs(bws_url, timeout=max(CDP_TIMEOUT, 20), label="browser")
        try:
            raw = (bws.call("Storage.getCookies", timeout=max(CDP_TIMEOUT, 20))
                   .get("cookies") or [])
        finally:
            bws.close()
        cookies = [_norm_cookie(c) for c in raw]
        live = [c for c in cookies if _cookie_alive(c)]
        expired = len(cookies) - len(live)
        warnings = []
        if expired:
            warnings.append("%d 条 cookie 已过期，未写入快照" % expired)

        storage, fails = _read_page_storage(endpoint)
        warned_origins = ["%s（%s）" % (o, e) for o, e in fails]

        # cookie 的 host_key 推断出的 origin：没有打开标签页的，默认只记录、不读（不出现在
        # 默认实例里开临时标签页）。--deep 且目标是 lane 时才开一次性标签页去读。
        seen_origins = set(storage)
        cookie_hosts = []
        for c in live:
            h = _cookie_host(c)
            if h and not _host_matches(h, [origin_host(o) for o in seen_origins]) and h not in cookie_hosts:
                cookie_hosts.append(h)
        deep_read = 0
        if deep and cookie_hosts and not is_default:
            bws2 = CdpWs(cdp_browser_ws(endpoint, timeout=8)[0], timeout=30, label="browser")
            try:
                for h in cookie_hosts[:12]:
                    origin = "https://" + h
                    tid = None
                    try:
                        tid, tws = cdp_create_target(bws2, endpoint, origin + "/", timeout=20)
                        if not tws:
                            continue
                        data = cdp_eval(tws, STORAGE_READ_JS, timeout=10)
                        if isinstance(data, dict):
                            storage[origin] = {"local": data.get("local") or {},
                                               "session": data.get("session") or {},
                                               "href": data.get("href"), "tabs": 1,
                                               "error": data.get("error")}
                            deep_read += 1
                    except CdpError as e:
                        warned_origins.append("%s（--deep %s）" % (origin, str(e)[:100]))
                    finally:
                        if tid:
                            try:
                                bws2.call("Target.closeTarget", {"targetId": tid}, timeout=5)
                            except Exception:
                                pass
            finally:
                bws2.close()
        elif deep and is_default:
            warnings.append("--deep 在默认实例(9222)上被忽略：不会为读 storage 开临时标签页")

        unknown = [h for h in cookie_hosts if ("https://" + h) not in storage]
        _mkdir_private(IDENTITY_ROOT)
        _mkdir_private(dest)
        _mkdir_private(identity_path(name, "storage"))
        domain_counts = {}
        for c in live:
            h = _cookie_host(c)
            domain_counts[h] = domain_counts.get(h, 0) + 1
        stats = {}
        for origin in sorted(storage):
            data = storage[origin]
            stats[origin] = {"local": len(data["local"]), "session": len(data["session"]),
                             "tabs": data.get("tabs", 1)}
            _write_private(identity_path(name, "storage", origin_filename(origin)),
                           {"schema": IDENTITY_SCHEMA, "origin": origin,
                            "captured_at": now_iso(), "href": data.get("href"),
                            "tabs": data.get("tabs", 1),
                            "local": data["local"], "session": data["session"],
                            "error": data.get("error")})
        _write_private(identity_path(name, "cookies.json"),
                       {"schema": IDENTITY_SCHEMA, "name": name, "saved_at": now_iso(),
                        "source": label, "count": len(live), "cookies": live})
        cdp_port = int(urllib.parse.urlsplit(endpoint).port or 0)
        meta = {
            "schema": IDENTITY_SCHEMA,
            "name": name,
            "created_at": now_iso(),
            "source": {"label": label, "kind": "default" if is_default else "lane",
                       "lane": lane_name, "cdp_port": cdp_port, "cdp_url": endpoint,
                       "profile": (lane_info or {}).get("profile") or DEFAULT_PROFILE,
                       "browser": ver.get("Browser"), "ua": ver.get("User-Agent")},
            "cookies": {"count": len(live), "raw_total": len(cookies),
                        "expired_dropped": expired,
                        "domains_count": len(domain_counts),
                        "domains": dict(sorted(domain_counts.items(), key=lambda kv: (-kv[1], kv[0])))},
            "origins": sorted(storage),
            "origin_stats": stats,
            "storage_unread_origins": sorted(unknown),
            "warnings": warnings + (["读不到 storage 的 origin：%s" % "; ".join(warned_origins)]
                                    if warned_origins else []),
            "tool": "browser.py identity save (schema %d)" % IDENTITY_SCHEMA,
        }
        _write_private(identity_path(name, "meta.json"), meta)
        try:
            os.chmod(identity_path(name, "cookies.json"), 0o600)
            os.chmod(identity_path(name, "meta.json"), 0o600)
        except OSError:
            pass
        elapsed = time.time() - t0
    finally:
        release_lock(lock_fd)

    print("身份 '%s' 已保存（%.2fs）" % (name, elapsed))
    print("  来源      %s（CDP %s，%s）" % (label, endpoint, ver.get("Browser") or "-"))
    print("  cookie    %d 条 / %d 个域名（原始 %d 条，丢弃过期 %d 条）"
          % (len(live), len(domain_counts), len(cookies), expired))
    print("    域名    %s" % _print_cookie_domains(domain_counts))
    print("  storage   %d 个 origin（localStorage+sessionStorage）" % len(storage))
    for origin in sorted(stats):
        st = stats[origin]
        print("    %-42s local %d 键 / session %d 键%s"
              % (origin, st["local"], st["session"],
                 "（%d 个标签页合并）" % st["tabs"] if st["tabs"] > 1 else ""))
    if deep_read:
        print("  --deep    额外读了 %d 个仅有 cookie 的 origin" % deep_read)
    if unknown:
        print("  未读      %d 个仅 cookie 的 origin 没有打开标签页，storage 未采集：%s"
              % (len(unknown), ", ".join(unknown[:12]) + (" …" if len(unknown) > 12 else "")))
    for w in warnings:
        print("  warning   %s" % w)
    print("  目录      %s（目录 0700 / 文件 0600）" % dest)
    print("  用法      browser identity load %s [--lane <lane>]" % name)
    return 0


def _resolve_storage_origins(snap, only):
    """Snapshot origins to restore, filtered by --only (host match on cookie suffix)."""
    out = []
    for origin in snap.get("origins") or []:
        if only and not _host_matches(origin_host(origin), only):
            continue
        out.append(origin)
    return out


def _load_snapshot(name, schema=None):
    check_identity_name(name)
    cpath = identity_path(name, "cookies.json")
    mpath = identity_path(name, "meta.json")
    if not os.path.isfile(cpath) or not os.path.isfile(mpath):
        raise LaneError("身份 '%s' 不存在（缺 %s；用 browser identity list 查看）" % (name, mpath))
    try:
        meta = _read_json(mpath)
        data = _read_json(cpath)
    except (OSError, ValueError) as e:
        raise LaneError("身份 '%s' 快照损坏：%s" % (name, e))
    got = int(meta.get("schema") or data.get("schema") or 0)
    if got > IDENTITY_SCHEMA:
        raise LaneError("身份 '%s' 的 schema 版本 %d 高于本工具支持的 %d；先升级工具，"
                        "不要用旧读取器猜新格式" % (name, got, IDENTITY_SCHEMA))
    # 目录名才是权威：手工改名/迁移过目录的快照仍然能用，不靠 meta 里可能过期的 name
    meta["name"] = name
    meta["cookies_data"] = data
    return meta


def identity_load(name, lane_name=None, only=None, no_tabs=False, quiet=False):
    snap = _load_snapshot(name)
    targets_only = parse_only(only) if isinstance(only, str) else (only or None)
    lane_info, endpoint, label, is_default = identity_target(lane_name)
    timeout = max(CDP_TIMEOUT, 20)
    t0 = time.time()
    lock_fd = _identity_lock(lane_name, is_default, label)
    try:
        bws_url, _ver = cdp_browser_ws(endpoint, timeout=CDP_TIMEOUT)
        bws = CdpWs(bws_url, timeout=timeout, label="browser")
        try:
            all_cookies = [c for c in ((snap.get("cookies_data") or {}).get("cookies") or [])
                           if _cookie_alive(c)]
            want = [c for c in all_cookies
                    if not targets_only or _host_matches(_cookie_host(c), targets_only)]
            warnings = []
            dropped = len(all_cookies) - len(want)
            if dropped > 0 and targets_only:
                pass
            set_ok = 0
            if want:
                try:
                    bws.call("Storage.setCookies",
                             {"cookies": [_cookie_param(c) for c in want]}, timeout=timeout)
                    set_ok = len(want)
                except CdpError as e:
                    warnings.append("批量 Storage.setCookies 失败（%s），逐条重试" % e)
                    for c in want:
                        try:
                            bws.call("Storage.setCookies", {"cookies": [_cookie_param(c)]},
                                     timeout=max(6, timeout // 2))
                            set_ok += 1
                        except CdpError:
                            pass
                    if set_ok == 0:
                        raise LaneError("cookie 一条都没灌进去（%s）；目标 %s 可能不支持 "
                                        "Storage.setCookies" % (e, label))
            # 回读校验：按 (name, domain, path, 分区) 对比，值不同也算不一致（不打印值）
            back = (bws.call("Storage.getCookies", timeout=timeout).get("cookies") or [])
            back_map = {}
            for c in back:
                back_map.setdefault(_ckey(_norm_cookie(c)), []).append(c.get("value"))
            confirmed, missing, value_diff = 0, [], []
            for c in want:
                vals = back_map.get(_ckey(c))
                if not vals:
                    missing.append("%s@%s%s" % (c.get("name"), c.get("domain"), c.get("path")))
                elif c.get("value") not in vals:
                    value_diff.append("%s@%s" % (c.get("name"), c.get("domain")))
                else:
                    confirmed += 1
        finally:
            bws.close()

        # storage：先写已有标签页；没有对应标签页的 origin 才开一次性标签页（默认实例永不）
        want_origins = _resolve_storage_origins(snap, targets_only)
        live_targets = {}
        for t in cdp_targets(endpoint, timeout=CDP_TIMEOUT) or []:
            if t.get("type") == "page" and t.get("webSocketDebuggerUrl"):
                o = url_origin(t.get("url"))
                if o:
                    live_targets.setdefault(o, []).append(t["webSocketDebuggerUrl"])
        storage_res = {}
        need_tab = [o for o in want_origins if o not in live_targets]
        if need_tab and is_default:
            warnings.append("默认实例上不开临时标签页：%d 个 origin 的 storage 未写入（%s）"
                            % (len(need_tab), ", ".join(need_tab[:6])))
        tabbed = []
        if need_tab and not is_default and not no_tabs:
            bws2 = CdpWs(cdp_browser_ws(endpoint, timeout=8)[0], timeout=40, label="browser")
            try:
                for origin in need_tab:
                    data = _snapshot_origin_data(snap, origin)
                    if not data or (not data.get("local") and not data.get("session")):
                        storage_res[origin] = {"local": 0, "session": 0, "where": "empty"}
                        continue
                    tid = None
                    try:
                        tid, tws = cdp_create_target(bws2, endpoint, origin + "/", timeout=25)
                        if not tws:
                            storage_res[origin] = {"local": 0, "session": 0, "where": "no-tab"}
                            continue
                        if not _wait_ready(tws, timeout=20, want_origin=origin):
                            storage_res[origin] = {"local": 0, "session": 0,
                                                   "where": "tab-not-ready"}
                            continue
                        got = cdp_eval(tws, STORAGE_WRITE_JS % json.dumps(
                            {"local": data.get("local") or {},
                             "session": data.get("session") or {}}, ensure_ascii=True), timeout=12)
                        storage_res[origin] = {"local": (got or {}).get("local", 0),
                                               "session": (got or {}).get("session", 0),
                                               "where": "new-tab",
                                               "error": (got or {}).get("error")}
                        tabbed.append(origin)
                    except CdpError as e:
                        storage_res[origin] = {"local": 0, "session": 0,
                                               "where": "error: %s" % str(e)[:100]}
                    finally:
                        if tid:
                            try:
                                bws2.call("Target.closeTarget", {"targetId": tid}, timeout=5)
                            except Exception:
                                pass
            finally:
                bws2.close()
        elif need_tab and no_tabs:
            warnings.append("--no-tabs：%d 个没有打开标签页的 origin 的 storage 未写入" % len(need_tab))

        for origin in want_origins:
            if origin in storage_res:
                continue
            data = _snapshot_origin_data(snap, origin)
            if not data:
                continue
            got = {"local": 0, "session": 0}
            err = None
            if not live_targets.get(origin):
                storage_res[origin] = {"local": 0, "session": 0, "where": "skipped",
                                       "error": "没有同源标签页"}
                continue
            for tws in live_targets.get(origin, []):
                try:
                    r = cdp_eval(tws, STORAGE_WRITE_JS % json.dumps(
                        {"local": data.get("local") or {},
                         "session": data.get("session") or {}}, ensure_ascii=True), timeout=10)
                    if isinstance(r, dict):
                        got["local"] = max(got["local"], r.get("local") or 0)
                        got["session"] = max(got["session"], r.get("session") or 0)
                        err = err or r.get("error")
                except CdpError as e:
                    err = str(e)[:120]
            storage_res[origin] = {"local": got["local"], "session": got["session"],
                                   "where": "live-tab", "error": err}
        # 抽验：对写入的 live-tab origin 回读键数
        for origin, res in list(storage_res.items()):
            if res.get("where") not in ("live-tab",):
                continue
            tws_list = live_targets.get(origin) or []
            if not tws_list:
                continue
            try:
                back = cdp_eval(tws_list[0], STORAGE_READ_JS, timeout=8) or {}
                res["verified"] = {"local": len(back.get("local") or {}),
                                   "session": len(back.get("session") or {})}
            except CdpError as e:
                res["verified"] = {"error": str(e)[:100]}
        elapsed = time.time() - t0
        result = {
            "name": name, "label": label, "endpoint": endpoint, "is_default": is_default,
            "only": targets_only, "cookies_expected": len(want), "cookies_written": set_ok,
            "cookies_confirmed": confirmed, "cookies_missing": missing,
            "cookies_value_diff": value_diff, "cookies_snapshot": len(all_cookies),
            "cookies_dropped_by_only": dropped,
            "storage": storage_res, "origins_requested": want_origins,
            "warnings": warnings, "seconds": elapsed, "tabbed": tabbed,
        }
        if missing:
            warnings.append("%d 条 cookie 回读缺失（例如 %s）；可能被站点/浏览器策略拒收"
                            % (len(missing), ", ".join(missing[:4])))
        if value_diff:
            warnings.append("%d 条 cookie 回读值不一致（例如 %s）"
                            % (len(value_diff), ", ".join(value_diff[:4])))
        return result
    finally:
        release_lock(lock_fd)


def _snapshot_origin_data(snap, origin):
    path = identity_path(snap["name"], "storage", origin_filename(origin))
    if not os.path.isfile(path):
        return None
    try:
        return _read_json(path)
    except (OSError, ValueError):
        return None


def _wait_ready(tws, timeout=15, want_origin=None):
    """Poll a freshly opened tab until it is the *right* origin and loaded.

    只等 document.readyState 是不够的：Target.createTarget 先给一个 about:blank，
    它立刻就是 complete，此时写 localStorage 会拿到 SecurityError（写 0 键）。
    """
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            state = cdp_eval(tws, "({ready: document.readyState, origin: location.origin})",
                             timeout=4)
        except CdpError:
            time.sleep(0.3)
            continue
        if isinstance(state, dict):
            if want_origin and state.get("origin") != want_origin:
                time.sleep(0.3)
                continue
            if state.get("ready") in ("interactive", "complete"):
                return True
        time.sleep(0.3)
    return False


def print_identity_load(res):
    print("身份 '%s' 已热灌 -> %s（%.2fs，未重启浏览器）"
          % (res["name"], res["label"], res["seconds"]))
    if res["only"]:
        print("  --only    %s（快照共 %d 条 cookie，按域过滤后 %d 条，丢弃 %d 条）"
              % (",".join(res["only"]), res["cookies_snapshot"],
                 res["cookies_expected"], res["cookies_dropped_by_only"]))
    print("  cookie    写入 %d 条，回读确认 %d 条%s"
          % (res["cookies_written"], res["cookies_confirmed"],
             "" if res["cookies_confirmed"] == res["cookies_written"]
             else " [不一致：缺 %d]" % (res["cookies_written"] - res["cookies_confirmed"])))
    if res["storage"]:
        print("  storage   %d 个 origin" % len(res["storage"]))
        for origin in sorted(res["storage"]):
            st = res["storage"][origin]
            v = st.get("verified") or {}
            extra = ""
            if v.get("local") is not None:
                extra = "，回读 local %d / session %d" % (v.get("local", 0), v.get("session", 0))
            print("    %-42s local 写 %d / session 写 %d（%s）%s"
                  % (origin, st.get("local", 0), st.get("session", 0),
                     st.get("where", "-"), extra))
    else:
        print("  storage   无（快照里没有可写 origin）")
    for w in res.get("warnings") or []:
        print("  warning   %s" % w)
    if res["is_default"]:
        print("  注意      目标是共享的默认实例：这次热灌会改动它当前的身份（本工具只读场景请用 identity stat）")


def identity_list(args):
    if args:
        raise LaneError("identity list 不带参数")
    if not os.path.isdir(IDENTITY_ROOT):
        print("无身份快照（%s 不存在）；先 browser identity save <name>" % IDENTITY_ROOT)
        return 0
    rows = []
    for name in sorted(os.listdir(IDENTITY_ROOT)):
        d = os.path.join(IDENTITY_ROOT, name)
        if not os.path.isdir(d):
            continue
        try:
            meta = _read_json(os.path.join(d, "meta.json"))
        except (OSError, ValueError) as e:
            rows.append((name, "-", "-", "-", "-", "损坏：%s" % str(e)[:60]))
            continue
        ck = meta.get("cookies") or {}
        rows.append((name, meta.get("created_at") or "-", str(ck.get("count", "?")),
                     str(ck.get("domains_count", "?")),
                     str(len(meta.get("origins") or [])),
                     ((meta.get("source") or {}).get("label") or "-")))
    if not rows:
        print("无身份快照（%s 为空）" % IDENTITY_ROOT)
        return 0
    print("%-20s %-26s %-8s %-8s %-8s %s"
          % ("NAME", "CREATED", "COOKIES", "DOMAINS", "ORIGINS", "SOURCE"))
    for r in rows:
        print("%-20s %-26s %-8s %-8s %-8s %s" % r)
    return 0


def identity_stat(args, lane_name=None):
    domain = None
    i = 0
    while i < len(args):
        a = args[i]
        if a == "--domain" and i + 1 < len(args):
            domain = args[i + 1].lstrip(".").lower()
            i += 2
        elif a.startswith("--domain="):
            domain = a.split("=", 1)[1].lstrip(".").lower()
            i += 1
        else:
            raise LaneError("identity stat 只接受 [--lane <lane>] [--domain <d>]，收到 %r" % a)
    lane_info, endpoint, label, is_default = identity_target(lane_name)
    bws = CdpWs(cdp_browser_ws(endpoint, timeout=CDP_TIMEOUT)[0],
                timeout=max(CDP_TIMEOUT, 20), label="browser")
    try:
        cookies = bws.call("Storage.getCookies", timeout=max(CDP_TIMEOUT, 20)).get("cookies") or []
    finally:
        bws.close()
    counts = {}
    for c in cookies:
        h = _cookie_host(_norm_cookie(c))
        if domain and not _host_matches(h, [domain]):
            continue
        counts[h] = counts.get(h, 0) + 1
    total = sum(counts.values())
    print("%s（CDP %s）cookie %d 条 / %d 个域名%s"
          % (label, endpoint, total, len(counts),
             "（--domain %s）" % domain if domain else ""))
    for d, n in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))[:30]:
        print("  %-38s %d" % (d, n))
    if len(counts) > 30:
        print("  … 另 %d 个域名" % (len(counts) - 30))
    return 0


def identity_cmd(args, lane_name=None):
    if not args or args[0] in ("-h", "--help", "help"):
        print(USAGE)
        return 0 if args else 2
    sub, rest = args[0], args[1:]
    if sub in ("list", "ls"):
        return identity_list(rest)
    if sub == "stat":
        return identity_stat(rest, lane_name=lane_name)
    if sub not in ("save", "load"):
        raise LaneError("未知 identity 子命令 %r（可用：save / load / list / stat）" % sub)
    name = None
    force = deep = no_tabs = False
    only = None
    i = 0
    while i < len(rest):
        a = rest[i]
        if a in ("--force", "-f"):
            force = True
            i += 1
        elif a == "--deep":
            deep = True
            i += 1
        elif a == "--no-tabs":
            no_tabs = True
            i += 1
        elif a == "--only":
            if i + 1 >= len(rest):
                raise LaneError("--only 需要逗号分隔的域名，例如 --only xiaohongshu.com")
            only = rest[i + 1]
            i += 2
        elif a.startswith("--only="):
            only = a.split("=", 1)[1]
            i += 1
        elif a.startswith("-"):
            raise LaneError("identity %s 不认识的参数 %r" % (sub, a))
        elif name is None:
            name = a
            i += 1
        else:
            raise LaneError("identity %s 只接受一个身份名，多出 %r" % (sub, a))
    if not name:
        raise LaneError("用法：browser identity %s <name> [--lane <lane>]%s"
                        % (sub, " [--only dom,dom]" if sub == "load" else " [--force] [--deep]"))
    if sub == "save":
        if only or no_tabs:
            raise LaneError("identity save 不接受 --only/--no-tabs")
        return identity_save(name, lane_name=lane_name, force=force, deep=deep)
    if force or deep:
        raise LaneError("identity load 不接受 --force/--deep")
    res = identity_load(name, lane_name=lane_name, only=only, no_tabs=no_tabs)
    print_identity_load(res)
    return 0


def lane_new(args):
    name = None
    size = None
    headless = False
    isolate = False
    proxy_spec = None
    fp = None
    identity = None
    i = 0
    while i < len(args):
        a = args[i]
        if a == "--name":
            if i + 1 >= len(args):
                raise LaneError("--name 需要一个名字")
            name = args[i + 1]
            i += 2
        elif a.startswith("--name="):
            name = a.split("=", 1)[1]
            i += 1
        elif a in ("--size",):
            if i + 1 >= len(args):
                raise LaneError("--size 需要 WxH，例如 1600x900")
            size = args[i + 1]
            i += 2
        elif a.startswith("--size="):
            size = a.split("=", 1)[1]
            i += 1
        elif a == "--headless":
            headless = True
            i += 1
        elif a == "--isolate":
            isolate = True
            i += 1
        elif a.startswith("--isolate="):
            v = a.split("=", 1)[1].strip().lower()
            if v not in ("1", "yes", "true", "google", "on"):
                raise LaneError("--isolate 不接受取值 %r（直接写 --isolate 即可）" % v)
            isolate = True
            i += 1
        elif a in ("--profile-preset", "--preset"):
            if i + 1 >= len(args):
                raise LaneError("%s 需要取值（当前只支持 google，等价 --isolate）" % a)
            if args[i + 1].strip().lower() != "google":
                raise LaneError("%s 只支持 google（等价 --isolate），收到 %r" % (a, args[i + 1]))
            isolate = True
            i += 2
        elif a.startswith("--profile-preset=") or a.startswith("--preset="):
            v = a.split("=", 1)[1].strip().lower()
            if v != "google":
                raise LaneError("--profile-preset 只支持 google（等价 --isolate），收到 %r" % v)
            isolate = True
            i += 1
        elif a == "--proxy":
            if i + 1 >= len(args):
                raise LaneError("--proxy 需要 host:port，例如 127.0.0.1:17891")
            proxy_spec = args[i + 1]
            i += 2
        elif a.startswith("--proxy="):
            proxy_spec = a.split("=", 1)[1]
            i += 1
        elif a in ("--fp", "--fingerprint"):
            if i + 1 >= len(args):
                raise LaneError("--fp 需要候选 id 或序号（1..%d）" % len(ISOLATE_PRESETS))
            fp = args[i + 1]
            i += 2
        elif a.startswith("--fp="):
            fp = a.split("=", 1)[1]
            i += 1
        elif a == "--identity":
            if i + 1 >= len(args):
                raise LaneError("--identity 需要身份快照名（browser identity list 查看）")
            identity = args[i + 1]
            i += 2
        elif a.startswith("--identity="):
            identity = a.split("=", 1)[1]
            i += 1
        elif a in ("-h", "--help"):
            print(USAGE)
            return 0
        else:
            raise LaneError("lane new 不认识的参数 %r\n%s" % (a, USAGE))
    width = height = None
    if size is not None:
        m = SIZE_RE.match(size or "")
        if not m:
            raise LaneError("--size 格式应为 WxH（例如 1600x900），收到 %r" % size)
        width, height = int(m.group(1)), int(m.group(2))
    if name is not None and not NAME_RE.match(name):
        raise LaneError("非法 lane 名 %r（允许 A-Za-z0-9_.-，首字符非 .-，最长 32）" % name)
    proxy = proxy_url = None
    if proxy_spec:
        # --proxy 与 --isolate 解耦：普通 lane 也能指定出口，且同样"不可用就硬失败"。
        _phost, _pport, proxy_url = parse_proxy(proxy_spec)
        proxy = "%s:%d" % (_phost, _pport)
    preset = None
    if fp and not isolate:
        raise LaneError("--fp 只在 --isolate 下有意义")
    if identity:
        snap = _load_snapshot(identity)  # 起 lane 前先证明快照可用，别建完才发现
        print("身份快照：%s（%d 条 cookie，%d 个 origin，来源 %s）"
              % (identity, (snap.get("cookies") or {}).get("count", "?"),
                 len(snap.get("origins") or []), (snap.get("source") or {}).get("label") or "?"),
              file=sys.stderr)

    # 代理必须在启动任何进程之前证明可用：宁可建 lane 失败，也不静默回落直连。
    probe_ip = probe_endpoint = direct_ip = None
    if proxy_url:
        # 无论是否 --isolate：代理必须在启动任何进程之前证明可用。
        if not proxy_tcp_ok(_phost, _pport):
            raise LaneError("代理 %s:%d 不可连接（TCP connect 失败）：拒绝创建 lane，"
                            "绝不回落直连" % (_phost, _pport))
        probe_ip, perr, probe_endpoint = fetch_exit_ip(proxy_url)
        if not probe_ip:
            raise LaneError("代理 %s 出口 IP 探测失败（%s）：拒绝创建 lane，绝不静默回落直连。"
                            "手工自测：curl -x %s --max-time 10 https://ifconfig.me/ip"
                            % (proxy_url, perr, proxy_url))
        direct_ip, _derr, _durl = fetch_exit_ip(None)
        print("代理探测：%s -> 出口 %s（探测端点 %s）%s"
              % (proxy_url, probe_ip, probe_endpoint,
                 "" if not direct_ip else "；本机直连出口 %s" % direct_ip),
              file=sys.stderr)
    elif isolate:
        direct_ip, derr, _durl = fetch_exit_ip(None)
        print("warning: --isolate 未指定 --proxy：本 lane 没有独立出口，走本机直连 IP %s；"
              "批量注册时所有账号同一 IP，风险自担%s"
              % (direct_ip or "（探测失败：%s）" % derr,
                 "" if direct_ip else "；此时连出口 IP 都无法确认"),
              file=sys.stderr)

    glock = acquire_lock(LANES_LOCK, 120, True, "lane 分配")
    spawned = []
    info = None
    created_dir = False  # rollback must never delete a directory this run did not create
    try:
        name = name or _new_name()
        if os.path.exists(lane_dir(name)):
            raise LaneError("lane '%s' 已存在（%s），不覆盖；换一个名字或先 browser lane kill %s"
                            % (name, lane_dir(name), name))
        win_w = win_h = None
        if isolate:
            preset = pick_preset(fp, used_preset_counts())
            if width is None:
                width, height = preset["screen"]
                win_w, win_h = preset["window"]
            else:  # 显式 --size 优先，窗口仍比屏幕矮一点
                win_w, win_h = width, max(height - ISO_WINDOW_TASKBAR, 200)
        if width is None:
            width, height = 1600, 900
            win_w, win_h = width, height
        if not isolate:
            win_w, win_h = width, height
        used = _used_ports()
        cdp_port = _pick_port(CDP_PORT_START, used)
        disp_num = None
        if not headless:
            disp_num = _pick_display()
        vnc_port = None
        web_port = None

        prof = os.path.join(lane_dir(name), "profile")
        os.makedirs(prof, mode=0o700)
        created_dir = True
        info = {
            "name": name,
            "cdp_port": cdp_port,
            "cdp_url": "http://127.0.0.1:%d" % cdp_port,
            "display": (":%d" % disp_num) if disp_num is not None else None,
            "headless": headless,
            "size": "%dx%d" % (width, height),
            "profile": prof,
            "vnc_port": None,
            "web_port": None,
            "watch_url": None,
            "chromium_pid": None,
            "chromium_pgid": None,
            "xvfb_pid": None,
            "xvfb_pgid": None,
            "x11vnc_pid": None,
            "x11vnc_pgid": None,
            "websockify_pid": None,
            "websockify_pgid": None,
            "created_at": now_iso(),
            "state": "booting",
            "status": "booting",
            "error": None,
        }
        if isolate:  # 普通 lane 的 lane.json 保持原样，不新增键
            info["window_size"] = "%dx%d" % (win_w, win_h)
            info["proxy"] = proxy
            info["proxy_url"] = proxy_url
            info["proxy_source"] = "explicit" if proxy_url else None
            info["isolate"] = None
        elif proxy_url:
            info["proxy"] = proxy
            info["proxy_url"] = proxy_url
            info["proxy_source"] = "explicit"
        else:
            info["proxy"] = (LANE_PROXY.split("://", 1)[-1] if LANE_PROXY else None)
            info["proxy_url"] = LANE_PROXY or None
            info["proxy_source"] = "env-default" if LANE_PROXY else None
        info["identity"] = None
        save_lane(info)
        ld = lane_dir(name)

        if not headless:
            env = dict(os.environ)
            xvfb_log = os.path.join(ld, "xvfb.log")
            p = _spawn(["/usr/bin/Xvfb", ":%d" % disp_num, "-screen", "0",
                        "%dx%dx24" % (width, height), "-nolisten", "tcp"], xvfb_log)
            spawned.append(("xvfb", p))
            info["xvfb_pid"] = p.pid
            info["xvfb_pgid"] = p.pid
            save_lane(info)
            if not wait_until(lambda: os.path.exists("/tmp/.X11-unix/X%d" % disp_num), 15):
                raise LaneError("Xvfb :%d 未在 15s 内就绪（日志 %s：%s）"
                                % (disp_num, xvfb_log, _log_tail(xvfb_log)))
            if p.poll() is not None:
                raise LaneError("Xvfb :%d 启动后立即退出（日志 %s：%s）"
                                % (disp_num, xvfb_log, _log_tail(xvfb_log)))
            env["DISPLAY"] = ":%d" % disp_num
        else:
            env = dict(os.environ)
            env.pop("DISPLAY", None)
            env["DISPLAY"] = ""

        if isolate:
            env["TZ"] = preset["timezone"]
            # 隔离 lane 自己的启动参数：UA / 语言 / 窗口尺寸都在启动期生效；
            # platform 与 timezone 由 CDP Emulation 覆盖（见 apply_iso_overrides）。
            chrome_argv = [
                CHROME,
                "--user-data-dir=%s" % prof,
                "--remote-debugging-address=127.0.0.1",
                "--remote-debugging-port=%d" % cdp_port,
                "--no-sandbox",
                "--disable-dev-shm-usage",
                "--disable-gpu",
                "--no-first-run",
                "--no-default-browser-check",
                "--test-type",
                "--disable-blink-features=AutomationControlled",
                "--disable-infobars",
                "--window-size=%d,%d" % (win_w, win_h),
                "--window-position=0,0",
                "--user-agent=%s" % preset["ua"],
                "--lang=%s" % preset["lang"],
                "--accept-lang=%s" % preset["accept_lang"],
                "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
                "--disable-features=Translate",
            ]
            if proxy_url:
                chrome_argv.append("--proxy-server=%s" % proxy_url)
        else:
            chrome_argv = [
                CHROME,
                "--user-data-dir=%s" % prof,
                "--remote-debugging-address=127.0.0.1",
                "--remote-debugging-port=%d" % cdp_port,
                "--no-sandbox",
                "--disable-dev-shm-usage",
                "--disable-gpu",
                "--no-first-run",
                "--no-default-browser-check",
                "--test-type",
                "--disable-blink-features=AutomationControlled",
                "--disable-infobars",
                "--window-size=%d,%d" % (width, height),
                "--window-position=0,0",
                "--start-maximized",
                "--lang=zh-CN",
                "--disable-features=Translate",
            ]
            if proxy_url:
                chrome_argv.append("--proxy-server=%s" % proxy_url)
                chrome_argv.append("--force-webrtc-ip-handling-policy=disable_non_proxied_udp")
            elif LANE_PROXY:
                chrome_argv.append("--proxy-server=%s" % LANE_PROXY)
        if headless:
            chrome_argv.append("--headless=new")
        chrome_argv.append("about:blank")

        chrome_log = os.path.join(ld, "chromium.log")
        pc = _spawn(chrome_argv, chrome_log, env=env)
        spawned.append(("chromium", pc))
        info["chromium_pid"] = pc.pid
        info["chromium_pgid"] = pc.pid
        save_lane(info)

        if not wait_until(lambda: cdp_version(cdp_port) is not None, 45):
            raise LaneError("Chromium CDP 127.0.0.1:%d 在 45s 内不可用（日志 %s：%s）"
                            % (cdp_port, chrome_log, _log_tail(chrome_log)))
        if pc.poll() is not None:
            raise LaneError("Chromium 在 CDP 就绪前退出（日志 %s：%s）"
                            % (chrome_log, _log_tail(chrome_log)))

        if isolate:
            iso = isolate_finalize(info, preset, proxy, proxy_url,
                                   probe_ip, probe_endpoint, direct_ip)
            info["isolate"] = iso
            info["exit_ip"] = iso.get("exit_ip")
            save_lane(info)
            for w in iso.get("warnings") or []:
                print("warning: isolate: %s" % w, file=sys.stderr)
        elif proxy_url:
            # 普通 lane 的显式代理同样要证明"真的走了代理"：实测 == 直连出口就拒绝保留。
            exit_ip, perr = cdp_probe_exit_ip(info["cdp_url"])
            if not exit_ip:
                raise LaneError("代理 %s 已启动但 lane 内实测不到出口 IP（%s）：拒绝保留该 lane，"
                                "绝不假设它走了代理" % (proxy_url, perr))
            if direct_ip and exit_ip == direct_ip:
                raise LaneError("代理被绕过：lane 实测出口 %s == 本机直连出口 %s（探测代理出口 %s）；"
                                "拒绝保留该 lane，绝不静默回落直连"
                                % (exit_ip, direct_ip, probe_ip))
            info["proxy"] = proxy
            info["proxy_url"] = proxy_url
            info["proxy_probe_exit_ip"] = probe_ip
            info["proxy_probe_endpoint"] = probe_endpoint
            info["direct_exit_ip"] = direct_ip
            info["exit_ip"] = exit_ip
            info["exit_ip_match"] = (exit_ip == probe_ip) if probe_ip else None
            save_lane(info)
            if probe_ip and exit_ip != probe_ip:
                print("warning: 代理出口不一致：探测 %s，lane 实测 %s"
                      % (probe_ip, exit_ip), file=sys.stderr)

        if not headless:
            used = _used_ports() | {cdp_port}
            vnc_port = _pick_port(VNC_PORT_START + disp_num - 100, used)
            vnc_log = os.path.join(ld, "x11vnc.log")
            pv = _spawn(["/usr/bin/x11vnc", "-display", ":%d" % disp_num,
                         "-localhost", "-rfbport", str(vnc_port), "-rfbportv6", "-1",
                         "-forever", "-shared", "-nopw", "-noxdamage", "-quiet",
                         "-noipv6", "-listen", "127.0.0.1"], vnc_log)
            spawned.append(("x11vnc", pv))
            info["x11vnc_pid"] = pv.pid
            info["x11vnc_pgid"] = pv.pid
            info["vnc_port"] = vnc_port
            save_lane(info)
            if not wait_until(lambda: port_open(vnc_port), 15):
                raise LaneError("x11vnc 127.0.0.1:%d 未在 15s 内监听（日志 %s：%s）"
                                % (vnc_port, vnc_log, _log_tail(vnc_log)))

            used = _used_ports() | {cdp_port, vnc_port}
            web_port = _pick_port(WEB_PORT_START, used)
            web_log = os.path.join(ld, "websockify.log")
            pw = _spawn([WEBSOCKIFY, "--web", NOVNC_WEB,
                         "127.0.0.1:%d" % web_port, "127.0.0.1:%d" % vnc_port], web_log)
            spawned.append(("websockify", pw))
            info["websockify_pid"] = pw.pid
            info["websockify_pgid"] = pw.pid
            info["web_port"] = web_port
            info["watch_url"] = ("http://127.0.0.1:%d/vnc.html"
                                 "?autoconnect=1&resize=remote&path=websockify" % web_port)
            save_lane(info)
            if not wait_until(lambda: port_open(web_port), 15):
                raise LaneError("websockify 127.0.0.1:%d 未在 15s 内监听（日志 %s：%s）"
                                % (web_port, web_log, _log_tail(web_log)))

        if identity:
            # 与 identity load 完全同一条代码路径（不是复制粘贴的第二套逻辑）
            res = identity_load(identity, lane_name=info["name"], quiet=True)
            info["identity"] = {
                "name": identity,
                "loaded_at": now_iso(),
                "cookies_written": res["cookies_written"],
                "cookies_confirmed": res["cookies_confirmed"],
                "origins": sorted(res["storage"]),
                "seconds": round(res["seconds"], 2),
            }
            info["identity_warnings"] = res.get("warnings") or []
            save_lane(info)
            print("身份 %s 已灌入（cookie 写入 %d / 回读确认 %d，%d 个 origin，%.2fs）"
                  % (identity, res["cookies_written"], res["cookies_confirmed"],
                     len(res["storage"]), res["seconds"]))
            for w in res.get("warnings") or []:
                print("warning: identity: %s" % w, file=sys.stderr)

        info["state"] = "running"
        info["status"] = "alive"
        info["ready_at"] = now_iso()
        save_lane(info)
    except BaseException as e:
        # roll back only what this invocation started
        for role, p in reversed(spawned):
            try:
                if p.poll() is None:
                    os.killpg(p.pid, signal.SIGTERM)
                    if not wait_until(lambda: p.poll() is not None, 4):
                        os.killpg(p.pid, signal.SIGKILL)
                        wait_until(lambda: p.poll() is not None, 2)
            except OSError:
                pass
        if info:
            try:
                _clean_x_locks(info)
            except Exception:
                pass
        if created_dir and name and os.path.isdir(lane_dir(name)):
            shutil.rmtree(lane_dir(name), ignore_errors=True)
        release_lock(glock)
        if isinstance(e, LaneError):
            raise
        raise LaneError("创建 lane 失败：%s" % e)
    release_lock(glock)

    print("lane '%s' 已就绪" % info["name"])
    print("  CDP        %s" % info["cdp_url"])
    print("  display    %s" % (info["display"] if info["display"] else "无（headless）"))
    print("  Chromium   pid %s (pgid %s)" % (info["chromium_pid"], info["chromium_pgid"]))
    print("  profile    %s" % info["profile"])
    print("  lane.json  %s" % lane_json_path(info["name"]))
    iso = info.get("isolate") or {}
    if iso.get("enabled"):
        eff = iso.get("effective") or {}
        print("  isolate    预设 %s（候选表 %d 组，轮换）" % (iso.get("preset"), len(ISOLATE_PRESETS)))
        print("             UA        %s" % iso.get("ua"))
        print("             platform  %s（实测 %s）" % (iso.get("platform"), eff.get("platform")))
        print("             lang      %s / Accept-Language %s（实测 %s）"
              % (iso.get("lang"), iso.get("accept_lang"), eff.get("languages")))
        print("             timezone  %s（实测 %s，offset %s 分钟）"
              % (iso.get("timezone"), eff.get("timezone"), eff.get("tzOffsetMinutes")))
        print("             screen    %s（实测 %s）  window %s（实测 outer %s）"
              % (iso.get("screen"), eff.get("screen"), iso.get("window"), eff.get("outer")))
        if iso.get("proxy"):
            print("             proxy     %s  探测出口 %s  实测出口 %s%s"
                  % (iso.get("proxy"), iso.get("proxy_probe_exit_ip") or "-",
                     iso.get("exit_ip") or "-",
                     "" if iso.get("exit_ip_match") is not False else "  [不一致，已告警]"))
        else:
            print("             proxy     无（直连出口 %s；同 IP 风险已告警）"
                  % (iso.get("exit_ip") or "未取到"))
        if headless:
            print("             注意      headless：屏幕尺寸不生效，screen/outer 仅由 --window-size 决定")
    elif info.get("proxy"):
        print("  proxy      %s（%s）  探测出口 %s  实测出口 %s%s"
              % (info.get("proxy"), info.get("proxy_source") or "-",
                 info.get("proxy_probe_exit_ip") or "-", info.get("exit_ip") or "-",
                 "" if info.get("exit_ip_match") is not False else "  [不一致，已告警]"))
    ident = info.get("identity") or {}
    if ident:
        print("  identity   %s（cookie 写入 %s / 回读确认 %s，%d 个 origin，%.2fs）"
              % (ident.get("name"), ident.get("cookies_written"),
                 ident.get("cookies_confirmed"), len(ident.get("origins") or []),
                 ident.get("seconds") or 0))
    if headless:
        print("  观看 URL   无（headless，本 lane 不提供 noVNC）")
    else:
        print("  观看 URL   %s" % info["watch_url"])
        print("  x11vnc     127.0.0.1:%d   websockify 127.0.0.1:%d"
              % (info["vnc_port"], info["web_port"]))
        print("  远程观看   ssh -L %d:127.0.0.1:%d root@<本机> 后在浏览器打开上面的 URL"
              % (info["web_port"], info["web_port"]))
    print("")
    print("后续用法:")
    print("  browser open --lane %s https://example.com" % info["name"])
    print("  browser shot --lane %s /tmp/%s.png" % (info["name"], info["name"]))
    print("  browser eval --lane %s 'document.title'" % info["name"])
    print("  browser tabs --lane %s" % info["name"])
    print("  browser lane kill %s" % info["name"])
    return 0


def iso_summary(info):
    """One compact line per isolate lane: UA short / lang / tz / screen / proxy / exit IP."""
    iso = info.get("isolate") or {}
    if not iso.get("enabled"):
        return None
    eff = iso.get("effective") or {}
    m = re.search(r"Chrome/(\d+)", iso.get("ua") or "")
    osname = "Win" if iso.get("platform") == "Win32" else ("Mac" if iso.get("platform") == "MacIntel" else "?")
    ua_short = "Chrome/%s %s" % (m.group(1) if m else "?", osname)
    tz_off = eff.get("tzOffsetMinutes")
    tz_short = "%s(offset %s)" % (iso.get("timezone"), tz_off if tz_off is not None else "?")
    proxy = iso.get("proxy") or "null(直连)"
    exit_ip = iso.get("exit_ip") or "-"
    probe = iso.get("proxy_probe_exit_ip") or "-"
    mismatch = " MISMATCH(probe=%s)" % probe if iso.get("exit_ip_match") is False else ""
    return ("  iso: %s | %s plat=%s | lang=%s | tz=%s | screen=%s win=%s | proxy=%s exit=%s%s"
            % (iso.get("preset"), ua_short, iso.get("platform"), iso.get("lang"),
               tz_short, iso.get("screen"), iso.get("window"), proxy, exit_ip, mismatch))


def lane_list(args):
    if args:
        raise LaneError("lane list 不带参数")
    lanes = scan_lanes()
    if not lanes:
        print("无 lane（用 browser lane new [--name X] 创建；默认实例仍是 127.0.0.1:9222）")
        return 0
    print("%-16s %-6s %-8s %-7s %-6s %-12s %-40s %s"
          % ("NAME", "CDP", "DISPLAY", "PID", "STATE", "IDENTITY", "PROFILE", "CREATED"))
    watches = []
    for name, info, err in lanes:
        if info is None:
            print("%-16s %s" % (name, err))
            continue
        state = lane_state(info)
        info["state"] = state
        ident = (info.get("identity") or {}).get("name") or "-"
        print("%-16s %-6s %-8s %-7s %-6s %-12s %-40s %s"
              % (name,
                 info.get("cdp_port") or "-",
                 info.get("display") or "headless",
                 info.get("chromium_pid") or "-",
                 state,
                 ident,
                 info.get("profile") or "-",
                 info.get("created_at") or "-"))
        line = iso_summary(info)
        if line:
            print(line)
        elif info.get("proxy"):
            print("  proxy: %s（%s） exit=%s"
                  % (info.get("proxy"), info.get("proxy_source") or "-",
                     info.get("exit_ip") or "-"))
        watches.append((name, info, state))
    print("")
    print("观看入口（noVNC 直连，open 即出画面）:")
    any_url = False
    for name, info, state in watches:
        url = watch_url(info)
        if not url:
            print("  %-16s 无（headless）" % name)
            continue
        any_url = True
        note = "" if state == "alive" else "  [%s，连不上时页面会显示断开]" % state
        print("  %-16s %s%s" % (name, url, note))
    if any_url:
        print("  远程观看：ssh -L <web端口>:127.0.0.1:<web端口> root@<本机> 后打开对应 URL")
    return 0


def lane_kill(args):
    if len(args) != 1:
        raise LaneError("用法：browser lane kill <name>")
    name = args[0]
    info = load_lane(name)
    if info.get("display") == ":99" or info.get("cdp_port") == 9222:
        raise LaneError("拒绝操作：lane '%s' 的元数据指向默认实例（:99 / 9222），不杀" % name)
    lk = acquire_lock(LANE_LOCK_FMT % name, 60, True, "lane %s" % name)
    try:
        alive_pids = [info.get("%s_pid" % r) for r in
                      ("chromium", "xvfb", "x11vnc", "websockify")]
        was_dead = not any(is_alive(p) for p in alive_pids)
        print("停止 lane '%s'（CDP %s，display %s）"
              % (name, info.get("cdp_port"), info.get("display") or "headless"))
        if was_dead:
            print("  进程已不存在，仅整理元数据")
        for role in ("websockify", "x11vnc", "chromium", "xvfb"):
            try:
                res = _terminate(role, info)
                if res not in ("已停止",) and not was_dead:
                    print("  %-11s %s" % (role, res))
            except Exception as e:
                print("  %-11s 清理失败：%s" % (role, e))
        removed = _clean_x_locks(info)
        for p in removed:
            print("  已删除 %s" % p)
        info["state"] = "killed"
        info["status"] = "dead"
        info["killed_at"] = now_iso()
        save_lane(info)
        left = [r for r in ("chromium", "xvfb", "x11vnc", "websockify")
                if is_alive(info.get("%s_pid" % r))]
        if left:
            print("warning: 仍有存活进程：%s" % ", ".join(left), file=sys.stderr)
        print("lane '%s' 已停止；profile 保留在 %s（未删除用户数据）"
              % (name, info.get("profile")))
        return 0
    finally:
        release_lock(lk)


def lane_cmd(args):
    if not args or args[0] in ("-h", "--help", "help"):
        print(USAGE)
        return 0 if args else 2
    sub, rest = args[0], args[1:]
    if sub == "list" or sub == "ls":
        return lane_list(rest)
    if sub == "new":
        return lane_new(rest)
    if sub == "kill" or sub == "rm":
        return lane_kill(rest)
    raise LaneError("未知 lane 子命令 %r（可用：list / new / kill）" % sub)


# --- default (9222) behaviour, unchanged --------------------------------------
def active_page(ctx):
    pages = [p for p in ctx.pages if not p.url.startswith("devtools://")]
    if not pages:
        return ctx.new_page()  # new tab in the existing context, not a new context
    for p in reversed(pages):
        try:
            if p.evaluate("document.visibilityState") == "visible":
                return p
        except Exception:
            pass
    return pages[-1]


def split_lane(args):
    lane, out, i = None, [], 0
    while i < len(args):
        a = args[i]
        if a == "--lane":
            if i + 1 >= len(args):
                raise LaneError("--lane 需要一个 lane 名字（browser lane list 查看）")
            lane = args[i + 1]
            i += 2
        elif a.startswith("--lane="):
            lane = a.split("=", 1)[1]
            i += 1
        else:
            out.append(a)
            i += 1
    return lane, out


def main(argv):
    if not argv or argv[0] in ("-h", "--help", "help"):
        print(USAGE); return 0
    try:
        lane_name, argv = split_lane(argv)
    except LaneError as e:
        print("error: %s" % e, file=sys.stderr); return 2
    cmd, args = argv[0], argv[1:]
    try:
        if cmd == "cdp-port":
            if lane_name:
                print(load_lane(lane_name).get("cdp_url") or CDP)
            else:
                print(CDP)
            return 0
        if cmd == "status":
            for s in SERVICES:
                r = subprocess.run(["systemctl", "is-active", s + ".service"], capture_output=True, text=True)
                print(f"{s}.service: {r.stdout.strip()}")
            if lane_name:  # lanes are plain processes, not systemd units
                info = load_lane(lane_name)
                print(f"lane {lane_name}: {lane_state(info)} cdp={info.get('cdp_url')} "
                      f"display={info.get('display') or 'headless'} pid={info.get('chromium_pid')}")
            return 0
        if cmd == "lane":
            return lane_cmd(args)
        if cmd == "identity":
            return identity_cmd(args, lane_name=lane_name)
        if cmd in ("open", "shot", "eval") and len(args) != 1:
            print(USAGE, file=sys.stderr); return 2
        if cmd not in ("open", "shot", "eval", "tabs"):
            print(USAGE, file=sys.stderr); return 2

        endpoint, lock_path, required, label = CDP, DEFAULT_LOCK, False, "默认实例(9222)"
        lane_info = None
        if lane_name:
            info = load_lane(lane_name)
            lane_info = info
            if lane_state(info) != "alive":
                raise LaneError("lane '%s' 不可用（CDP 127.0.0.1:%s 无响应，状态 %s）；"
                                "用 browser lane list 检查，或 browser lane new --name %s 重建"
                                % (lane_name, info.get("cdp_port"), lane_state(info), lane_name))
            endpoint = "http://127.0.0.1:%d" % int(info["cdp_port"])
            lock_path = LANE_LOCK_FMT % lane_name
            required, label = True, "lane %s" % lane_name

        lock_timeout = LANE_LOCK_TIMEOUT if lane_name else DEFAULT_LOCK_TIMEOUT
        lock_fd = acquire_lock(lock_path, lock_timeout, required, label)
        try:
            with sync_playwright() as pw:
                browser = pw.chromium.connect_over_cdp(endpoint)
                try:
                    if not browser.contexts:
                        print("error: browser has no default context", file=sys.stderr); return 1
                    ctx = browser.contexts[0]
                    if cmd == "tabs":
                        for i, p in enumerate(ctx.pages):
                            print(f"[{i}] {p.title()!r} {p.url}")
                        return 0
                    page = active_page(ctx)
                    iso = (lane_info or {}).get("isolate") or {}
                    preset = preset_by_id(iso.get("preset")) if iso.get("enabled") else None
                    iso_cdp = None
                    if preset:
                        # Emulation 覆盖随 CDP 会话存在：整个动作期间必须保持会话不 detach，
                        # 否则 navigator.platform / Sec-CH-UA 会退回 Linux 真值。
                        try:
                            iso_cdp, iwarns = iso_attach(ctx, page, preset)
                            for w in iwarns:
                                print("warning: isolate: %s" % w, file=sys.stderr)
                        except Exception as e:
                            print("warning: isolate 覆盖失败（本次动作按未隔离执行）：%s"
                                  % str(e).splitlines()[0][:160], file=sys.stderr)
                    try:
                        if cmd == "open":
                            page.bring_to_front()
                            page.goto(args[0], wait_until="load", timeout=60000)
                            print(json.dumps({"url": page.url, "title": page.title()}, ensure_ascii=False))
                        elif cmd == "shot":
                            page.screenshot(path=args[0])
                            print(args[0])
                        elif cmd == "eval":
                            print(json.dumps(page.evaluate(args[0]), ensure_ascii=False))
                    finally:
                        if iso_cdp is not None:
                            try:
                                iso_cdp.detach()
                            except Exception:
                                pass
                    return 0
                finally:
                    # Leaving the context manager stops the driver and only drops the CDP connection;
                    # browser.close() is deliberately never called.
                    pass
        finally:
            release_lock(lock_fd)
    except LaneError as e:
        print("error: %s" % e, file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
