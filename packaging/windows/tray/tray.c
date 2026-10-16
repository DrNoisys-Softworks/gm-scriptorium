/*
 * tray.c: the icon in the system tray, its menu and notifications, the single running copy,
 * sign-out and shutdown, and Start with Windows (ADR 0057, sections 1 and 4 to 11).
 *
 * The words the GM reads follow the storyboard frames T01 to T10 and N01 to N05 with the owner's
 * notes applied ("system tray", balloon notifications with no buttons where a click does the main
 * action). test/tray-structure.test.js pins the wording, the registry names, the four places a
 * program is started and the two functions allowed to write the registry.
 *
 * Arguments: none (a start the GM makes), --background (from the Run value at sign-in),
 * --handoff (from `gm-scriptorium` in a terminal: exit 0 delivered, 3 started one, 4 the running
 * copy is in an error state, 1 nothing was started), --autostart on|off (Setup; exit 0 or 1, no
 * window). Anything else exits 1.
 */
#include "tray.h"

#include <stdlib.h>
#include <string.h>
#include <windowsx.h>

#define CAP(a) (sizeof(a) / sizeof((a)[0]))
#define DOT L" \u00B7 "

#define WM_TRAY_ICON (WM_APP + 1)
#define TRAY_ICON_ID 1
#define TIMER_CONFIRM 1
#define TIMER_ICON 2
#define CONFIRM_WAIT_MS 5000
#define ICON_RETRY_MS 2000
#define ICON_RETRIES 30
#define FIND_WAIT_MS 10000
#define CONFIRM_BUTTON 100

enum {
    IDM_OPEN = 1000,
    IDM_PREVIEW,
    IDM_STOP,
    IDM_START,
    IDM_RESTART,
    IDM_UPDATES,
    IDM_AUTOSTART,
    IDM_CMD,
    IDM_LOGS,
    IDM_QUIT,
    IDM_RETRY,
    IDM_PORTS,
    IDM_SIGNIN,
    IDM_INERT
};

enum tray_state { ST_STARTING, ST_RUNNING, ST_STOPPED, ST_ERROR };
enum err_kind { ERR_VAULT, ERR_PORT, ERR_CONFIG, ERR_OTHER, ERR_MISMATCH, ERR_GONE };
enum toast_kind { TOAST_NONE, TOAST_FIRST_RUN, TOAST_ERROR, TOAST_PORT, TOAST_UPDATE };
enum pending { PENDING_NONE, PENDING_STOP, PENDING_QUIT };

static const wchar_t MUTEX_NAME[] = L"Local\\GM-Scriptorium-tray";
static const wchar_t RUN_KEY[] = L"Software\\Microsoft\\Windows\\CurrentVersion\\Run";
static const wchar_t APPROVED_KEY[] = L"Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run";
static const wchar_t RUN_VALUE[] = L"GM-Scriptorium";
static const wchar_t TOAST_KEY[] = L"Software\\GM-Scriptorium\\Tray";

static const wchar_t CMD_ARGS_HEAD[] = L" /d /s /k \"title GM-Scriptorium command line & echo GM-Scriptorium ";
static const wchar_t CMD_ARGS_TAIL[] =
    L" command line & echo GM-Scriptorium keeps running in the background. Commands here work alongside it. & echo Try gm-scriptorium status, gm-scriptorium check or gm-scriptorium --help.\"";

static const wchar_t MISMATCH_TEXT[] = L"Quit GM-Scriptorium and start it again from the Start menu to finish updating.";
static const wchar_t SIGNIN_LOCAL_TEXT[] = L"Remote access is off at sign-in on this PC.";
/* ADR 0057 section 7: the tray item, its failure line and the confirm box for turning it on. */
static const wchar_t SIGNIN_ITEM_TEXT[] = L"Remote access at sign-in";
static const wchar_t SIGNIN_FAILED_TEXT[] = L"The sign-in setting couldn't be saved. Details are in the log folder.";
static const wchar_t SIGNIN_CONFIRM_TITLE[] = L"Start remote access when you sign in to Windows?";
static const wchar_t SIGNIN_CONFIRM_TEXT[] = L"Anyone your remote access setup lets through can reach the sign-in page whenever this PC is on.";
static const wchar_t SIGNIN_CONFIRM_BUTTON[] = L"Turn on";

static struct {
    HINSTANCE inst;
    HWND hwnd;
    UINT taskbar_created;
    HICON icon_small;
    HICON icon_large;
    HICON badged[5];
    int icon_added;
    int icon_tries;
    struct host host;
    int background;
    int hello_ok;
    int quitting;
    int in_dialog;
    enum tray_state st;
    wchar_t campaign[128];
    wchar_t detail[256];
    wchar_t reach[16];
    wchar_t address[256];
    wchar_t panel_port[8];
    int signin_local;
    int signin_confirmed;
    int signin_asked;
    int signin_failed;
    enum err_kind err;
    wchar_t err_msg[320];
    wchar_t err_port[8];
    wchar_t log_dir[1024];
    int have_update;
    wchar_t update_ver[48];
    char notes_url[256];
    enum toast_kind toast;
    enum pending pending;
} g;

/* ---------------------------------------------------------------------------------------------
 * Small string helpers
 * ------------------------------------------------------------------------------------------- */

static void wset(wchar_t *dst, size_t cap, const wchar_t *src)
{
    wtrunc(dst, cap, src);
}

static void wcat(wchar_t *dst, size_t cap, const wchar_t *src)
{
    size_t used = wcslen(dst);
    if (used + 1 < cap) wtrunc(dst + used, cap - used, src);
}

/* A field from the host, UTF-8, into a fixed wide buffer. */
static void wset_utf8(wchar_t *dst, size_t cap, const char *src)
{
    wchar_t *w = utf8_to_wide(src != NULL ? src : "");
    wtrunc(dst, cap, w != NULL ? w : L"");
    free(w);
}

/* Menu text with every & doubled, so a campaign name never turns into a keyboard accelerator. */
static void menu_text(wchar_t *dst, size_t cap, const wchar_t *src)
{
    size_t n = 0;
    for (; *src != L'\0' && n + 2 < cap; src++) {
        if (*src == L'&') dst[n++] = L'&';
        dst[n++] = *src;
    }
    dst[n] = L'\0';
}

static const char *arg(const struct proto_line *pl, size_t i)
{
    return i < pl->nargs && i < TRAY_MAX_FIELDS && pl->args[i] != NULL ? pl->args[i] : "";
}

/* ---------------------------------------------------------------------------------------------
 * The registry: Start with Windows (ADR 0057 section 7) and which notifications were shown
 * ------------------------------------------------------------------------------------------- */

/* Ticked when the Run value exists and Task Manager has not switched it off (first byte 0x03 of
 * the StartupApproved value means disabled). */
static int autostart_get(void)
{
    HKEY k;
    int present = 0;
    int disabled = 0;
    if (RegOpenKeyExW(HKEY_CURRENT_USER, RUN_KEY, 0, KEY_QUERY_VALUE, &k) == ERROR_SUCCESS) {
        present = RegQueryValueExW(k, RUN_VALUE, NULL, NULL, NULL, NULL) == ERROR_SUCCESS;
        RegCloseKey(k);
    }
    if (RegOpenKeyExW(HKEY_CURRENT_USER, APPROVED_KEY, 0, KEY_QUERY_VALUE, &k) == ERROR_SUCCESS) {
        BYTE data[64];
        DWORD size = sizeof data;
        if (RegQueryValueExW(k, RUN_VALUE, NULL, NULL, data, &size) == ERROR_SUCCESS && size >= 1 && data[0] == 0x03) disabled = 1;
        RegCloseKey(k);
    }
    return present && !disabled;
}

/*
 * The only writer that sets the Run value: "<this exe>" --background, per user, never machine-wide.
 * Turning it on also clears Task Manager's "disabled" switch, so the tick means what it says.
 */
static int autostart_set(int on)
{
    HKEY run;
    if (RegCreateKeyExW(HKEY_CURRENT_USER, RUN_KEY, 0, NULL, 0, KEY_SET_VALUE, NULL, &run, NULL) != ERROR_SUCCESS) return 0;
    if (!on) {
        LONG rc = RegDeleteValueW(run, RUN_VALUE);
        RegCloseKey(run);
        return rc == ERROR_SUCCESS || rc == ERROR_FILE_NOT_FOUND;
    }
    static wchar_t self[32768];
    static wchar_t data[32768 + 32];
    DWORD n = GetModuleFileNameW(NULL, self, CAP(self));
    if (n == 0 || n >= CAP(self)) {
        RegCloseKey(run);
        return 0;
    }
    data[0] = L'\0';
    wcat(data, CAP(data), L"\"");
    wcat(data, CAP(data), self);
    wcat(data, CAP(data), L"\" --background");
    LONG rc = RegSetValueExW(run, RUN_VALUE, 0, REG_SZ, (const BYTE *)data, (DWORD)((wcslen(data) + 1) * sizeof(wchar_t)));
    RegCloseKey(run);
    if (rc != ERROR_SUCCESS) return 0;

    HKEY approved;
    if (RegOpenKeyExW(HKEY_CURRENT_USER, APPROVED_KEY, 0, KEY_QUERY_VALUE | KEY_SET_VALUE, &approved) == ERROR_SUCCESS) {
        BYTE cur[64];
        DWORD size = sizeof cur;
        if (RegQueryValueExW(approved, RUN_VALUE, NULL, NULL, cur, &size) == ERROR_SUCCESS && size >= 1 && cur[0] == 0x03) {
            static const BYTE enabled[12] = { 0x02, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0 };
            RegSetValueExW(approved, RUN_VALUE, 0, REG_BINARY, enabled, sizeof enabled);
        }
        RegCloseKey(approved);
    }
    return 1;
}

/* HKCU\Software\GM-Scriptorium\Tray: FirstRunToast (DWORD) and UpdateToast (SZ). */
static void toast_state_set(const wchar_t *name, DWORD type, const void *data, DWORD size)
{
    HKEY k;
    if (RegCreateKeyExW(HKEY_CURRENT_USER, TOAST_KEY, 0, NULL, 0, KEY_SET_VALUE, NULL, &k, NULL) != ERROR_SUCCESS) return;
    RegSetValueExW(k, name, 0, type, (const BYTE *)data, size);
    RegCloseKey(k);
}

static int first_run_toast_shown(void)
{
    HKEY k;
    DWORD v = 0;
    DWORD size = sizeof v;
    if (RegOpenKeyExW(HKEY_CURRENT_USER, TOAST_KEY, 0, KEY_QUERY_VALUE, &k) != ERROR_SUCCESS) return 0;
    LONG rc = RegQueryValueExW(k, L"FirstRunToast", NULL, NULL, (BYTE *)&v, &size);
    RegCloseKey(k);
    return rc == ERROR_SUCCESS && v != 0;
}

static int update_toast_shown(const wchar_t *version)
{
    HKEY k;
    wchar_t seen[64];
    DWORD size = sizeof seen - sizeof(wchar_t);
    if (RegOpenKeyExW(HKEY_CURRENT_USER, TOAST_KEY, 0, KEY_QUERY_VALUE, &k) != ERROR_SUCCESS) return 0;
    memset(seen, 0, sizeof seen);
    LONG rc = RegQueryValueExW(k, L"UpdateToast", NULL, NULL, (BYTE *)seen, &size);
    RegCloseKey(k);
    return rc == ERROR_SUCCESS && wcscmp(seen, version) == 0;
}

/* ---------------------------------------------------------------------------------------------
 * The icon: the Lantern from this file's own resources, with a badge per state (frames T01 to T09)
 * ------------------------------------------------------------------------------------------- */

static HICON icon_with_badge(HICON base, int kind)
{
    ICONINFO ii;
    if (base == NULL || !GetIconInfo(base, &ii)) return NULL;
    HICON out = NULL;
    BITMAP bm;
    if (ii.hbmColor != NULL && GetObjectW(ii.hbmColor, sizeof bm, &bm) == sizeof bm && bm.bmWidth > 0 && bm.bmHeight > 0) {
        const int w = bm.bmWidth;
        const int h = bm.bmHeight;
        BITMAPINFO bi;
        memset(&bi, 0, sizeof bi);
        bi.bmiHeader.biSize = sizeof bi.bmiHeader;
        bi.bmiHeader.biWidth = w;
        bi.bmiHeader.biHeight = -h;
        bi.bmiHeader.biPlanes = 1;
        bi.bmiHeader.biBitCount = 32;
        bi.bmiHeader.biCompression = BI_RGB;
        HDC dc = CreateCompatibleDC(NULL);
        void *bits = NULL;
        HBITMAP colour = dc != NULL ? CreateDIBSection(dc, &bi, DIB_RGB_COLORS, &bits, NULL, 0) : NULL;
        uint8_t *mask_bits = calloc((size_t)(((w + 15) / 16) * 2) * (size_t)h, 1);
        if (colour != NULL && bits != NULL && mask_bits != NULL && GetDIBits(dc, ii.hbmColor, 0, (UINT)h, bits, &bi, DIB_RGB_COLORS) == h) {
            uint32_t *px = bits;
            int any_alpha = 0;
            for (int i = 0; i < w * h; i++) any_alpha |= (px[i] >> 24) != 0;
            if (!any_alpha) {
                for (int i = 0; i < w * h; i++) {
                    if (px[i] & 0x00ffffffu) px[i] |= 0xff000000u;
                }
            }
            badge_paint(px, w, h, kind);
            HBITMAP mask = CreateBitmap(w, h, 1, 1, mask_bits);
            if (mask != NULL) {
                ICONINFO ni;
                memset(&ni, 0, sizeof ni);
                ni.fIcon = TRUE;
                ni.hbmMask = mask;
                ni.hbmColor = colour;
                out = CreateIconIndirect(&ni);
                DeleteObject(mask);
            }
        }
        free(mask_bits);
        if (colour != NULL) DeleteObject(colour);
        if (dc != NULL) DeleteDC(dc);
    }
    if (ii.hbmColor != NULL) DeleteObject(ii.hbmColor);
    if (ii.hbmMask != NULL) DeleteObject(ii.hbmMask);
    return out;
}

static void icons_free(void)
{
    for (size_t i = 0; i < CAP(g.badged); i++) {
        if (g.badged[i] != NULL) DestroyIcon(g.badged[i]);
        g.badged[i] = NULL;
    }
    if (g.icon_small != NULL) DestroyIcon(g.icon_small);
    if (g.icon_large != NULL) DestroyIcon(g.icon_large);
    g.icon_small = NULL;
    g.icon_large = NULL;
}

/* Loaded at the size Windows wants now, and again when the taskbar is recreated. */
static void icons_load(void)
{
    icons_free();
    LoadIconMetric(g.inst, MAKEINTRESOURCEW(IDI_LANTERN), LIM_SMALL, &g.icon_small);
    LoadIconMetric(g.inst, MAKEINTRESOURCEW(IDI_LANTERN), LIM_LARGE, &g.icon_large);
    for (int k = BADGE_STARTING; k <= BADGE_STOPPED; k++) g.badged[k] = icon_with_badge(g.icon_small, k);
}

static HICON current_icon(void)
{
    int kind = BADGE_NONE;
    if (g.st == ST_STARTING) kind = BADGE_STARTING;
    else if (g.st == ST_STOPPED) kind = BADGE_STOPPED;
    else if (g.st == ST_ERROR) kind = BADGE_ERROR;
    else if (g.have_update) kind = BADGE_UPDATE;
    return kind != BADGE_NONE && g.badged[kind] != NULL ? g.badged[kind] : g.icon_small;
}

/* The tooltip (frames T01 and T08). */
static void tooltip(wchar_t *out, size_t cap)
{
    out[0] = L'\0';
    switch (g.st) {
    case ST_RUNNING:
        wset(out, cap, g.campaign[0] != L'\0' ? L"GM-Scriptorium: running, " : L"GM-Scriptorium: running");
        wcat(out, cap, g.campaign);
        break;
    case ST_STOPPED:
        wset(out, cap, g.campaign[0] != L'\0' ? L"GM-Scriptorium: panel stopped, " : L"GM-Scriptorium: panel stopped");
        wcat(out, cap, g.campaign);
        break;
    case ST_STARTING:
        wset(out, cap, L"GM-Scriptorium: starting");
        break;
    case ST_ERROR:
        wset(out, cap, g.err == ERR_MISMATCH ? L"GM-Scriptorium: start it again to finish updating" : L"GM-Scriptorium: couldn't start");
        break;
    }
}

static void icon_data(NOTIFYICONDATAW *nid)
{
    memset(nid, 0, sizeof *nid);
    nid->cbSize = sizeof *nid;
    nid->hWnd = g.hwnd;
    nid->uID = TRAY_ICON_ID;
}

static int icon_add(void)
{
    NOTIFYICONDATAW nid;
    icon_data(&nid);
    nid.uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP | NIF_SHOWTIP;
    nid.uCallbackMessage = WM_TRAY_ICON;
    nid.hIcon = current_icon();
    tooltip(nid.szTip, CAP(nid.szTip));
    if (!Shell_NotifyIconW(NIM_ADD, &nid)) {
        /* Explorer may not be ready yet at sign-in: try again shortly. */
        if (g.icon_tries++ < ICON_RETRIES) SetTimer(g.hwnd, TIMER_ICON, ICON_RETRY_MS, NULL);
        return 0;
    }
    nid.uVersion = NOTIFYICON_VERSION_4;
    Shell_NotifyIconW(NIM_SETVERSION, &nid);
    g.icon_added = 1;
    return 1;
}

static void icon_refresh(void)
{
    if (!g.icon_added) return;
    NOTIFYICONDATAW nid;
    icon_data(&nid);
    nid.uFlags = NIF_ICON | NIF_TIP | NIF_SHOWTIP;
    nid.hIcon = current_icon();
    tooltip(nid.szTip, CAP(nid.szTip));
    Shell_NotifyIconW(NIM_MODIFY, &nid);
}

static void icon_remove(void)
{
    if (!g.icon_added) return;
    NOTIFYICONDATAW nid;
    icon_data(&nid);
    Shell_NotifyIconW(NIM_DELETE, &nid);
    g.icon_added = 0;
}

/* ---------------------------------------------------------------------------------------------
 * Notifications: balloons, which Windows 10 and 11 show as toasts. No buttons; a click does the
 * main action (owner ruling DQ1), and the other actions are in the menu.
 * ------------------------------------------------------------------------------------------- */

static void toast_show(enum toast_kind kind, const wchar_t *title, const wchar_t *text)
{
    if (!g.icon_added) return;
    NOTIFYICONDATAW nid;
    icon_data(&nid);
    nid.uFlags = NIF_INFO;
    nid.dwInfoFlags = NIIF_USER | NIIF_LARGE_ICON;
    nid.hBalloonIcon = g.icon_large;
    wtrunc(nid.szInfoTitle, CAP(nid.szInfoTitle), title);
    wtrunc(nid.szInfo, CAP(nid.szInfo), text);
    if (Shell_NotifyIconW(NIM_MODIFY, &nid)) g.toast = kind;
}

/* N01, once per Windows user, on a start the GM made. */
static void toast_first_run(void)
{
    if (g.background || first_run_toast_shown()) return;
    toast_show(TOAST_FIRST_RUN, L"GM-Scriptorium is running", L"Find its icon in the system tray, by the clock. Closing your browser doesn't stop GM-Scriptorium.");
    DWORD one = 1;
    toast_state_set(L"FirstRunToast", REG_DWORD, &one, sizeof one);
}

/* N03 and N05, and the version mismatch. */
static void toast_error(void)
{
    wchar_t text[256];
    if (g.err == ERR_PORT) {
        if (g.err_port[0] != L'\0') {
            wset(text, CAP(text), L"Port ");
            wcat(text, CAP(text), g.err_port);
            wcat(text, CAP(text), L" is in use by another program");
        } else {
            wtrunc(text, CAP(text) - 32, g.err_msg);
        }
        wcat(text, CAP(text), L". Click to change ports.");
        toast_show(TOAST_PORT, L"GM-Scriptorium couldn't start", text);
        return;
    }
    if (g.err == ERR_MISMATCH) {
        toast_show(TOAST_ERROR, L"GM-Scriptorium couldn't start", MISMATCH_TEXT);
        return;
    }
    static const wchar_t suffix[] = L" Click to try again.";
    wtrunc(text, CAP(text) - (CAP(suffix) - 1), g.err_msg);
    wcat(text, CAP(text), suffix);
    toast_show(TOAST_ERROR, L"GM-Scriptorium couldn't start", text);
}

/* N04, once per version. */
static void toast_update(void)
{
    if (update_toast_shown(g.update_ver)) return;
    wchar_t title[64];
    wchar_t text[256];
    wset(title, CAP(title), L"GM-Scriptorium ");
    wcat(title, CAP(title), g.update_ver);
    wcat(title, CAP(title), L" is available");
    wset(text, CAP(text), L"You have ");
    wcat(text, CAP(text), TRAY_APP_VERSION_W);
    wcat(text, CAP(text), L". Click to view the patch notes.");
    toast_show(TOAST_UPDATE, title, text);
    toast_state_set(L"UpdateToast", REG_SZ, g.update_ver, (DWORD)((wcslen(g.update_ver) + 1) * sizeof(wchar_t)));
}

/* ---------------------------------------------------------------------------------------------
 * Opening things
 * ------------------------------------------------------------------------------------------- */

/* The log folder from `hello`, only when it is an absolute path to a folder that exists. */
static void open_log_folder(void)
{
    if (!path_is_absolute(g.log_dir)) return;
    DWORD attrs = GetFileAttributesW(g.log_dir);
    if (attrs == INVALID_FILE_ATTRIBUTES || !(attrs & FILE_ATTRIBUTE_DIRECTORY)) return;
    ShellExecuteW(NULL, L"open", g.log_dir, NULL, NULL, SW_SHOWNORMAL);
}

/* The patch notes, only when the address is a release page of this project on GitHub. */
static void open_notes(void)
{
    if (!notes_url_ok(g.notes_url)) return;
    wchar_t *url = utf8_to_wide(g.notes_url);
    if (url == NULL) return;
    ShellExecuteW(NULL, L"open", url, NULL, NULL, SW_SHOWNORMAL);
    free(url);
}

/* "Open command line (Advanced)" is offered only when the install folder can be quoted safely. */
static int cmd_available(void)
{
    static wchar_t dir[32768];
    return own_dir(dir, CAP(dir)) && wcschr(dir, L'"') == NULL && wcschr(dir, L'%') == NULL;
}

/*
 * cmd.exe from the system folder, never from PATH, in a new console in the user's profile folder,
 * with the install folder first on PATH for that window only (ADR 0057 section 10). Windows picks
 * the terminal host. SYSTEM_COMMANDS in the program does not grow.
 */
static void cmd_open(void)
{
    static wchar_t dir[32768];
    static wchar_t sys[MAX_PATH];
    static wchar_t app[MAX_PATH + 16];
    static wchar_t cmd[2048];
    if (!own_dir(dir, CAP(dir)) || wcschr(dir, L'"') != NULL || wcschr(dir, L'%') != NULL) return;
    UINT n = GetSystemDirectoryW(sys, CAP(sys));
    if (n == 0 || n >= CAP(sys)) return;
    wset(app, CAP(app), sys);
    wcat(app, CAP(app), L"\\cmd.exe");
    wset(cmd, CAP(cmd), L"\"");
    wcat(cmd, CAP(cmd), app);
    wcat(cmd, CAP(cmd), L"\"");
    wcat(cmd, CAP(cmd), CMD_ARGS_HEAD);
    wcat(cmd, CAP(cmd), TRAY_APP_VERSION_W);
    wcat(cmd, CAP(cmd), CMD_ARGS_TAIL);

    LPWCH current = GetEnvironmentStringsW();
    if (current == NULL) return;
    wchar_t *env = env_with_path_first(current, dir);
    FreeEnvironmentStringsW(current);
    if (env == NULL) return;
    STARTUPINFOW si;
    memset(&si, 0, sizeof si);
    si.cb = sizeof si;
    PROCESS_INFORMATION pi;
    if (CreateProcessW(app, cmd, NULL, NULL, FALSE, CREATE_NEW_CONSOLE | CREATE_UNICODE_ENVIRONMENT, env, user_profile(), &si, &pi)) {
        CloseHandle(pi.hThread);
        CloseHandle(pi.hProcess);
    }
    free(env);
}

/*
 * `--handoff` with nothing running starts a separate copy with no arguments (a start the GM made)
 * and exits 3 (Lead amendment 3a). The handoff process never becomes the instance itself: the
 * terminal's job object closes with the terminal, and the copy started here breaks away from it.
 */
static int self_start(void)
{
    static wchar_t self[32768];
    static wchar_t cmd[32768 + 4];
    DWORD n = GetModuleFileNameW(NULL, self, CAP(self));
    if (n == 0 || n >= CAP(self)) return 0;
    wset(cmd, CAP(cmd), L"\"");
    wcat(cmd, CAP(cmd), self);
    wcat(cmd, CAP(cmd), L"\"");
    STARTUPINFOW si;
    memset(&si, 0, sizeof si);
    si.cb = sizeof si;
    PROCESS_INFORMATION pi;
    if (!CreateProcessW(self, cmd, NULL, NULL, FALSE, 0, NULL, user_profile(), &si, &pi)) return 0;
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
    return 1;
}

/* ---------------------------------------------------------------------------------------------
 * Talking to the host
 * ------------------------------------------------------------------------------------------- */

static void enter_error(enum err_kind kind, const wchar_t *msg)
{
    g.st = ST_ERROR;
    g.err = kind;
    wset(g.err_msg, CAP(g.err_msg), msg);
    if (kind != ERR_PORT) g.err_port[0] = L'\0';
    toast_error();
    icon_refresh();
}

/* Try again: a retry line to a host that is still running, or a fresh host (a start the GM made)
 * when it has gone. */
static void do_retry(void)
{
    if (host_alive(&g.host)) {
        host_send(&g.host, HELPER_RETRY, NULL);
        return;
    }
    host_release(&g.host);
    g.hello_ok = 0;
    g.background = 0;
    g.st = ST_STARTING;
    g.campaign[0] = L'\0';
    g.detail[0] = L'\0';
    g.signin_local = 0;
    g.signin_confirmed = 0;
    g.signin_asked = SIGNIN_ASKED_NONE;
    g.signin_failed = 0;
    icon_refresh();
    if (!host_spawn(&g.host, g.hwnd, 0)) enter_error(ERR_GONE, L"GM-Scriptorium could not start gm-scriptorium.exe from its install folder.");
}

static void act(enum pending what)
{
    if (what == PENDING_STOP) {
        host_send(&g.host, HELPER_STOP, NULL);
    } else if (what == PENDING_QUIT) {
        PostMessageW(g.hwnd, WM_CLOSE, 0, 0);
    }
}

/* Stop panel and Quit ask the host first; it answers with a confirm line (ADR 0057 section 5). */
static void ask(enum pending what)
{
    if (!host_alive(&g.host)) {
        if (what == PENDING_QUIT) act(what);
        return;
    }
    g.pending = what;
    host_send(&g.host, what == PENDING_STOP ? HELPER_STOP_ASK : HELPER_QUIT_ASK, NULL);
    SetTimer(g.hwnd, TIMER_CONFIRM, CONFIRM_WAIT_MS, NULL);
}

/* Frame T07, and Stop panel the same way. Cancel is the default button. */
static int confirm(enum pending what, const char *why)
{
    const int quit = what == PENDING_QUIT;
    const int remote = strcmp(why, "remote") == 0;
    TASKDIALOG_BUTTON button = { CONFIRM_BUTTON, quit ? L"Quit" : L"Stop panel" };
    TASKDIALOGCONFIG c;
    memset(&c, 0, sizeof c);
    c.cbSize = sizeof c;
    c.hInstance = g.inst;
    c.dwFlags = TDF_ALLOW_DIALOG_CANCELLATION;
    c.dwCommonButtons = TDCBF_CANCEL_BUTTON;
    c.pszWindowTitle = L"GM-Scriptorium";
    c.pszMainIcon = TD_WARNING_ICON;
    c.pszMainInstruction = quit ? L"Quit GM-Scriptorium?" : L"Stop the panel?";
    if (quit) {
        c.pszContent = remote ? L"Remote access is on. Quitting signs out anyone using the panel from another device, and turns off your preview."
                              : L"A preview build is running. Quitting stops it partway; your vault isn't changed.";
    } else {
        c.pszContent = remote ? L"Remote access is on. Stopping the panel signs out anyone using it from another device, and turns off your preview."
                              : L"A preview build is running. Stopping the panel stops it partway; your vault isn't changed.";
    }
    c.cButtons = 1;
    c.pButtons = &button;
    c.nDefaultButton = IDCANCEL;
    int pressed = IDCANCEL;
    SetForegroundWindow(g.hwnd);
    g.in_dialog++;
    HRESULT hr = TaskDialogIndirect(&c, &pressed, NULL, NULL);
    g.in_dialog--;
    return SUCCEEDED(hr) && pressed == CONFIRM_BUTTON;
}

static void on_confirm(const char *why)
{
    enum pending what = g.pending;
    if (what == PENDING_NONE) return;
    KillTimer(g.hwnd, TIMER_CONFIRM);
    g.pending = PENDING_NONE;
    if (strcmp(why, "none") == 0 || confirm(what, why)) act(what);
}

/* Turning remote access at sign-in on (ADR 0057 section 7). Cancel is the default button. */
static int confirm_signin(void)
{
    TASKDIALOG_BUTTON button = { CONFIRM_BUTTON, SIGNIN_CONFIRM_BUTTON };
    TASKDIALOGCONFIG c;
    memset(&c, 0, sizeof c);
    c.cbSize = sizeof c;
    c.hInstance = g.inst;
    c.dwFlags = TDF_ALLOW_DIALOG_CANCELLATION;
    c.dwCommonButtons = TDCBF_CANCEL_BUTTON;
    c.pszWindowTitle = L"GM-Scriptorium";
    c.pszMainIcon = TD_WARNING_ICON;
    c.pszMainInstruction = SIGNIN_CONFIRM_TITLE;
    c.pszContent = SIGNIN_CONFIRM_TEXT;
    c.cButtons = 1;
    c.pButtons = &button;
    c.nDefaultButton = IDCANCEL;
    int pressed = IDCANCEL;
    SetForegroundWindow(g.hwnd);
    g.in_dialog++;
    HRESULT hr = TaskDialogIndirect(&c, &pressed, NULL, NULL);
    g.in_dialog--;
    return SUCCEEDED(hr) && pressed == CONFIRM_BUTTON;
}

/* The tray item. Which way it goes comes from the host's last signin= field; the tick changes only when the
 * host's next running line says so. */
static void signin_toggle(void)
{
    const int turn_on = !g.signin_confirmed;
    if (turn_on && !confirm_signin()) return;
    g.signin_asked = turn_on ? SIGNIN_ASKED_ON : SIGNIN_ASKED_OFF;
    if (!host_send(&g.host, HELPER_SIGNIN, turn_on ? "on" : "off")) g.signin_asked = SIGNIN_ASKED_NONE;
}

static void on_hello(const struct proto_line *pl)
{
    if (g.hello_ok) return;
    if (!hello_matches(arg(pl, 0), arg(pl, 1))) {
        /* An old helper with a new program, or the reverse (Lead amendment 4b). */
        host_stop(&g.host, 2000);
        enter_error(ERR_MISMATCH, MISMATCH_TEXT);
        return;
    }
    g.hello_ok = 1;
    wset_utf8(g.log_dir, CAP(g.log_dir), arg(pl, 2));
}

static enum err_kind err_kind_of(const char *kind)
{
    if (strcmp(kind, "vault") == 0) return ERR_VAULT;
    if (strcmp(kind, "port") == 0) return ERR_PORT;
    if (strcmp(kind, "config") == 0) return ERR_CONFIG;
    return ERR_OTHER;
}

/* The digits after the last colon of a local address, the panel's own port. */
static void port_of_address(const wchar_t *address, wchar_t *out, size_t cap)
{
    const wchar_t *colon = wcsrchr(address, L':');
    out[0] = L'\0';
    if (colon != NULL && port_field_ok(colon + 1)) wset(out, cap, colon + 1);
}

static void on_state(const struct proto_line *pl)
{
    const char *what = arg(pl, 0);
    const char *campaign = arg(pl, 1);
    if (strcmp(what, "starting") == 0) {
        g.st = ST_STARTING;
        /* Restart, Start panel and a retry re-read the settings: forget the sign-in markers until the
         * next running line says them again. */
        g.signin_local = 0;
        g.signin_confirmed = 0;
        g.signin_asked = SIGNIN_ASKED_NONE;
        g.signin_failed = 0;
        wset_utf8(g.campaign, CAP(g.campaign), strcmp(campaign, "-") == 0 ? "" : campaign);
        wset_utf8(g.detail, CAP(g.detail), arg(pl, 2));
    } else if (strcmp(what, "running") == 0) {
        g.st = ST_RUNNING;
        wset_utf8(g.campaign, CAP(g.campaign), campaign);
        wset_utf8(g.reach, CAP(g.reach), arg(pl, 2));
        wset_utf8(g.address, CAP(g.address), arg(pl, 3));
        if (wcscmp(g.reach, L"local") == 0) port_of_address(g.address, g.panel_port, CAP(g.panel_port));
        /* Owner ruling RV1: a sign-in start that runs local-only because remote access at sign-in
         * has not been confirmed. The host marks it with an optional last field. */
        g.signin_local = strcmp(arg(pl, 4), "signin-local") == 0;
        /* Whether a start at sign-in would use remote access on this PC: the trailing signin= field. */
        g.signin_confirmed = signin_confirmed((const char *const *)pl->args, pl->nargs < TRAY_MAX_FIELDS ? pl->nargs : TRAY_MAX_FIELDS);
        /* ADR 0057 section 7: a change asked for from the tray failed when this line does not say it. */
        g.signin_failed = signin_write_failed(g.signin_asked, g.signin_confirmed);
        g.signin_asked = SIGNIN_ASKED_NONE;
        icon_refresh();
        toast_first_run();
        return;
    } else if (strcmp(what, "stopped") == 0) {
        g.st = ST_STOPPED;
        wset_utf8(g.campaign, CAP(g.campaign), strcmp(campaign, "-") == 0 ? "" : campaign);
    } else if (strcmp(what, "error") == 0) {
        wchar_t msg[320];
        wset_utf8(msg, CAP(msg), arg(pl, 2));
        wchar_t port[8];
        wset_utf8(port, CAP(port), arg(pl, 3));
        enum err_kind kind = err_kind_of(arg(pl, 1));
        wset(g.err_port, CAP(g.err_port), port_field_ok(port) ? port : L"");
        enter_error(kind, msg);
        return;
    } else {
        return;
    }
    icon_refresh();
}

static void on_update(const struct proto_line *pl)
{
    wchar_t ver[48];
    wset_utf8(ver, CAP(ver), arg(pl, 0));
    if (ver[0] == L'\0') return;
    g.have_update = 1;
    wset(g.update_ver, CAP(g.update_ver), ver);
    const char *url = arg(pl, 1);
    g.notes_url[0] = '\0';
    if (strlen(url) < sizeof g.notes_url && notes_url_ok(url)) memcpy(g.notes_url, url, strlen(url) + 1);
    icon_refresh();
    toast_update();
}

static void on_line(const struct proto_line *pl)
{
    if (!pl->is_host) return;
    if (!g.hello_ok && pl->verb != HOST_HELLO) return;
    switch (pl->verb) {
    case HOST_HELLO: on_hello(pl); break;
    case HOST_STATE: on_state(pl); break;
    case HOST_CONFIRM: on_confirm(arg(pl, 0)); break;
    case HOST_UPDATE: on_update(pl); break;
    default: break;
    }
}

static void on_host_eof(void)
{
    if (g.quitting) return;
    KillTimer(g.hwnd, TIMER_CONFIRM);
    g.pending = PENDING_NONE;
    if (g.st == ST_ERROR && g.err == ERR_MISMATCH) return;
    enter_error(ERR_GONE, L"The panel stopped unexpectedly.");
}

/* ---------------------------------------------------------------------------------------------
 * The change-ports window (frame T10)
 * ------------------------------------------------------------------------------------------- */

static void ports_note(HWND dlg)
{
    wchar_t panel[8];
    wchar_t note[200];
    GetDlgItemTextW(dlg, IDC_PORT_PANEL, panel, CAP(panel));
    note[0] = L'\0';
    if (port_field_ok(panel)) {
        wset(note, CAP(note), L"Your panel will be at http://127.0.0.1:");
        wcat(note, CAP(note), panel);
        wcat(note, CAP(note), L".");
        if (g.panel_port[0] != L'\0' && wcscmp(g.panel_port, panel) != 0) {
            wcat(note, CAP(note), L" Bookmarks to :");
            wcat(note, CAP(note), g.panel_port);
            wcat(note, CAP(note), L" stop working.");
        }
    }
    SetDlgItemTextW(dlg, IDC_PORTS_NOTE, note);
}

static INT_PTR CALLBACK ports_proc(HWND dlg, UINT msg, WPARAM wp, LPARAM lp)
{
    (void)lp;
    switch (msg) {
    case WM_INITDIALOG: {
        wchar_t title[200];
        if (g.err_port[0] != L'\0') {
            wset(title, CAP(title), L"Port ");
            wcat(title, CAP(title), g.err_port);
            wcat(title, CAP(title), L" is in use by another program");
        } else {
            wset(title, CAP(title), g.err_msg);
        }
        SetDlgItemTextW(dlg, IDC_PORTS_TITLE, title);
        SendDlgItemMessageW(dlg, IDC_PORT_PANEL, EM_LIMITTEXT, 5, 0);
        SendDlgItemMessageW(dlg, IDC_PORT_PREVIEW, EM_LIMITTEXT, 5, 0);
        HICON warn = NULL;
        if (SUCCEEDED(LoadIconMetric(NULL, IDI_WARNING, LIM_LARGE, &warn))) {
            SendDlgItemMessageW(dlg, IDC_PORTS_ICON, STM_SETICON, (WPARAM)warn, 0);
        }
        ports_note(dlg);
        SetForegroundWindow(dlg);
        return TRUE;
    }
    case WM_COMMAND:
        if (LOWORD(wp) == IDC_PORT_PANEL && HIWORD(wp) == EN_CHANGE) {
            ports_note(dlg);
            return TRUE;
        }
        if (LOWORD(wp) == IDOK) {
            wchar_t panel[8];
            wchar_t preview[8];
            wchar_t first[256];
            GetDlgItemTextW(dlg, IDC_PORT_PANEL, panel, CAP(panel));
            GetDlgItemTextW(dlg, IDC_PORT_PREVIEW, preview, CAP(preview));
            if (!port_field_ok(panel) || !port_field_ok(preview)) {
                SetDlgItemTextW(dlg, IDC_PORTS_ERROR, L"Type a number of up to five digits for each port.");
                return TRUE;
            }
            HCURSOR old = SetCursor(LoadCursorW(NULL, IDC_WAIT));
            int rc = desktop_set_run(panel, preview, first, CAP(first));
            SetCursor(old);
            if (rc == 0) {
                if (host_alive(&g.host)) host_send(&g.host, HELPER_START, NULL);
                else do_retry();
                EndDialog(dlg, IDOK);
                return TRUE;
            }
            if (first[0] == L'\0') {
                wset(first, CAP(first), rc == -2 ? L"Saving the ports did not finish within 15 seconds." : L"The ports could not be saved.");
            }
            SetDlgItemTextW(dlg, IDC_PORTS_ERROR, first);
            return TRUE;
        }
        if (LOWORD(wp) == IDCANCEL) {
            EndDialog(dlg, IDCANCEL);
            return TRUE;
        }
        break;
    default:
        break;
    }
    return FALSE;
}

static void ports_dialog(void)
{
    if (g.in_dialog) return;
    g.in_dialog++;
    DialogBoxParamW(g.inst, MAKEINTRESOURCEW(IDD_PORTS), NULL, ports_proc, 0);
    g.in_dialog--;
}

/* ---------------------------------------------------------------------------------------------
 * The menu (frames T02 to T09). The header is greyed text items.
 * ------------------------------------------------------------------------------------------- */

static void add_item(HMENU m, UINT id, const wchar_t *text, int enabled)
{
    AppendMenuW(m, MF_STRING | (enabled ? 0 : MF_GRAYED), id, text);
}

static void add_header(HMENU m, const wchar_t *text)
{
    wchar_t escaped[512];
    if (text[0] == L'\0') return;
    menu_text(escaped, CAP(escaped), text);
    AppendMenuW(m, MF_STRING | MF_GRAYED, IDM_INERT, escaped);
}

static void add_sep(HMENU m)
{
    AppendMenuW(m, MF_SEPARATOR, 0, NULL);
}

static const wchar_t *reach_label(const wchar_t *reach)
{
    if (wcscmp(reach, L"ssh") == 0) return L"Remote: SSH tunnel";
    if (wcscmp(reach, L"tailscale") == 0) return L"Remote: Tailscale";
    if (wcscmp(reach, L"proxy") == 0) return L"Remote: reverse proxy";
    if (wcscmp(reach, L"direct") == 0) return L"Remote: direct, own certificate";
    return NULL;
}

static int remote_on(void)
{
    return g.st == ST_RUNNING && reach_label(g.reach) != NULL;
}

static void header(HMENU m)
{
    wchar_t line[400];
    add_header(m, L"GM-Scriptorium " TRAY_APP_VERSION_W);
    switch (g.st) {
    case ST_RUNNING: {
        wset(line, CAP(line), L"Running");
        if (g.campaign[0] != L'\0') {
            wcat(line, CAP(line), DOT);
            wcat(line, CAP(line), g.campaign);
        }
        add_header(m, line);
        const wchar_t *remote = reach_label(g.reach);
        if (remote != NULL) {
            add_header(m, remote);
            add_header(m, g.address);
        } else {
            const wchar_t *shown = wcsncmp(g.address, L"http://", 7) == 0 ? g.address + 7 : g.address;
            wset(line, CAP(line), L"This PC only");
            if (shown[0] != L'\0') {
                wcat(line, CAP(line), DOT);
                wcat(line, CAP(line), shown);
            }
            add_header(m, line);
        }
        if (signin_header_shown(g.signin_local, g.signin_confirmed)) add_header(m, SIGNIN_LOCAL_TEXT);
        break;
    }
    case ST_STARTING:
        wset(line, CAP(line), L"Starting");
        if (g.campaign[0] != L'\0') {
            wcat(line, CAP(line), DOT);
            wcat(line, CAP(line), g.campaign);
        }
        add_header(m, line);
        add_header(m, g.detail);
        break;
    case ST_STOPPED:
        wset(line, CAP(line), L"Panel stopped");
        if (g.campaign[0] != L'\0') {
            wcat(line, CAP(line), DOT);
            wcat(line, CAP(line), g.campaign);
        }
        add_header(m, line);
        add_header(m, L"Nothing is listening. Start it again here.");
        break;
    case ST_ERROR:
        if (g.err == ERR_MISMATCH) {
            add_header(m, MISMATCH_TEXT);
        } else if (g.err == ERR_PORT && g.err_port[0] != L'\0') {
            wset(line, CAP(line), L"Port ");
            wcat(line, CAP(line), g.err_port);
            wcat(line, CAP(line), L" is in use by another program");
            add_header(m, line);
            add_header(m, L"The panel can't start on it.");
        } else {
            add_header(m, g.err == ERR_VAULT ? L"Can't reach your vault" : L"GM-Scriptorium couldn't start");
            wtrunc(line, 121, g.err_msg);
            add_header(m, line);
        }
        break;
    }
}

static HMENU build_menu(void)
{
    HMENU m = CreatePopupMenu();
    if (m == NULL) return NULL;
    const int autostart = autostart_get();
    const int cmd_ok = cmd_available();
    wchar_t updates[96];
    if (g.have_update) {
        wset(updates, CAP(updates), L"Update available: ");
        wcat(updates, CAP(updates), g.update_ver);
    } else {
        wset(updates, CAP(updates), L"Check for updates");
    }

    header(m);
    add_sep(m);
    if (g.st == ST_ERROR) {
        if (g.err == ERR_PORT) {
            add_item(m, IDM_PORTS, L"Change ports...", 1);
            add_item(m, IDM_RETRY, L"Try again", 1);
            SetMenuDefaultItem(m, IDM_PORTS, FALSE);
        } else if (g.err != ERR_MISMATCH) {
            add_item(m, IDM_RETRY, L"Try again", 1);
            SetMenuDefaultItem(m, IDM_RETRY, FALSE);
        }
        add_item(m, IDM_LOGS, L"Open log folder", 1);
        add_sep(m);
        add_item(m, IDM_OPEN, L"Open panel", 0);
        add_item(m, IDM_PREVIEW, L"Open preview", 0);
        add_sep(m);
        add_item(m, IDM_UPDATES, updates, 1);
        AppendMenuW(m, MF_STRING | (autostart ? MF_CHECKED : 0), IDM_AUTOSTART, L"Start with Windows");
        add_sep(m);
        add_item(m, IDM_CMD, L"Open command line (Advanced)", cmd_ok);
    } else if (g.st == ST_STOPPED) {
        add_item(m, IDM_START, L"Start panel", 1);
        SetMenuDefaultItem(m, IDM_START, FALSE);
        add_item(m, IDM_OPEN, L"Open panel", 0);
        add_item(m, IDM_PREVIEW, L"Open preview", 0);
        add_item(m, IDM_INERT, L"Only you can see it. Not your published site.", 0);
        add_sep(m);
        add_item(m, IDM_RESTART, L"Restart", 0);
        add_sep(m);
        add_item(m, IDM_UPDATES, updates, 1);
        AppendMenuW(m, MF_STRING | (autostart ? MF_CHECKED : 0), IDM_AUTOSTART, L"Start with Windows");
        add_sep(m);
        add_item(m, IDM_CMD, L"Open command line (Advanced)", cmd_ok);
        add_item(m, IDM_LOGS, L"Open log folder", 1);
    } else {
        const int on = g.st == ST_RUNNING;
        add_item(m, IDM_OPEN, L"Open panel", on);
        if (on) SetMenuDefaultItem(m, IDM_OPEN, FALSE);
        add_item(m, IDM_PREVIEW, L"Open preview", on);
        add_item(m, IDM_INERT, L"Only you can see it. Not your published site.", 0);
        add_sep(m);
        add_item(m, IDM_STOP, L"Stop panel", on);
        add_item(m, IDM_RESTART, L"Restart", on);
        add_sep(m);
        add_item(m, IDM_UPDATES, updates, on);
        AppendMenuW(m, MF_STRING | (autostart ? MF_CHECKED : 0), IDM_AUTOSTART, L"Start with Windows");
        const int signin = signin_item(on, remote_on(), g.signin_local, autostart);
        if (signin != SIGNIN_ITEM_HIDDEN) {
            AppendMenuW(m, MF_STRING | (g.signin_confirmed ? MF_CHECKED : 0) | (signin == SIGNIN_ITEM_GREYED ? MF_GRAYED : 0), IDM_SIGNIN, SIGNIN_ITEM_TEXT);
            if (g.signin_failed) add_item(m, IDM_INERT, SIGNIN_FAILED_TEXT, 0);
        }
        add_sep(m);
        add_item(m, IDM_CMD, L"Open command line (Advanced)", cmd_ok);
        add_item(m, IDM_LOGS, L"Open log folder", 1);
    }
    add_sep(m);
    add_item(m, IDM_QUIT, L"Quit GM-Scriptorium", 1);
    return m;
}

static void on_command(UINT id)
{
    switch (id) {
    case IDM_OPEN: host_send(&g.host, HELPER_OPEN, NULL); break;
    case IDM_PREVIEW: host_send(&g.host, HELPER_OPEN, "preview"); break;
    case IDM_UPDATES: host_send(&g.host, HELPER_OPEN, "updates"); break;
    case IDM_STOP: ask(PENDING_STOP); break;
    case IDM_START: host_send(&g.host, HELPER_START, NULL); break;
    case IDM_RESTART: host_send(&g.host, HELPER_RESTART, NULL); break;
    case IDM_RETRY: do_retry(); break;
    case IDM_PORTS: ports_dialog(); break;
    case IDM_AUTOSTART: autostart_set(!autostart_get()); break;
    case IDM_SIGNIN: signin_toggle(); break;
    case IDM_CMD: cmd_open(); break;
    case IDM_LOGS: open_log_folder(); break;
    case IDM_QUIT: ask(PENDING_QUIT); break;
    default: break;
    }
}

static void show_menu(int x, int y)
{
    if (g.in_dialog) return;
    HMENU m = build_menu();
    if (m == NULL) return;
    SetForegroundWindow(g.hwnd);
    UINT align = GetSystemMetrics(SM_MENUDROPALIGNMENT) ? TPM_RIGHTALIGN : TPM_LEFTALIGN;
    UINT cmd = (UINT)TrackPopupMenuEx(m, TPM_RETURNCMD | TPM_RIGHTBUTTON | TPM_NONOTIFY | TPM_BOTTOMALIGN | align, x, y, g.hwnd, NULL);
    PostMessageW(g.hwnd, WM_NULL, 0, 0);
    DestroyMenu(m);
    if (cmd != 0) on_command(cmd);
}

static void on_toast_click(void)
{
    switch (g.toast) {
    case TOAST_ERROR:
        if (g.st == ST_ERROR && g.err != ERR_MISMATCH) do_retry();
        break;
    case TOAST_PORT:
        if (g.st == ST_ERROR && g.err == ERR_PORT) ports_dialog();
        break;
    case TOAST_UPDATE: open_notes(); break;
    default: break;
    }
}

static void on_icon(UINT event, WPARAM wp)
{
    switch (event) {
    case WM_CONTEXTMENU: show_menu(GET_X_LPARAM(wp), GET_Y_LPARAM(wp)); break;
    case WM_LBUTTONDBLCLK:
        /* Double-click opens the panel; a stopped panel is started first by the host. */
        if (g.st == ST_ERROR) {
            POINT pt;
            GetCursorPos(&pt);
            show_menu(pt.x, pt.y);
        } else {
            host_send(&g.host, HELPER_OPEN, NULL);
        }
        break;
    case NIN_BALLOONUSERCLICK: on_toast_click(); break;
    default: break;
    }
}

/* ---------------------------------------------------------------------------------------------
 * The single instance and the end of the session
 * ------------------------------------------------------------------------------------------- */

static int payload_is(const COPYDATASTRUCT *cd, const wchar_t *word)
{
    size_t bytes = wcslen(word) * sizeof(wchar_t);
    if (cd->cbData != bytes && cd->cbData != bytes + sizeof(wchar_t)) return 0;
    if (memcmp(cd->lpData, word, bytes) != 0) return 0;
    return cd->cbData == bytes || ((const wchar_t *)cd->lpData)[wcslen(word)] == L'\0';
}

/* A second launch: open a tab, or in an error state show the notification and the log folder. */
static LRESULT on_copydata(const COPYDATASTRUCT *cd)
{
    if (cd == NULL || cd->dwData != TRAY_COPYDATA_TAG || cd->lpData == NULL) return TRAY_REPLY_REFUSED;
    if (!payload_is(cd, L"open") && !payload_is(cd, L"handoff")) return TRAY_REPLY_REFUSED;
    if (g.quitting) return TRAY_REPLY_REFUSED;
    if (g.st == ST_ERROR) {
        toast_error();
        open_log_folder();
        return TRAY_REPLY_ERROR;
    }
    return host_send(&g.host, HELPER_OPEN, NULL) ? TRAY_REPLY_OPENED : TRAY_REPLY_REFUSED;
}

/* Quit now, with no confirm: the host is told to quit, given wait_ms, then ended. */
static void quit_now(DWORD wait_ms)
{
    if (g.quitting) return;
    g.quitting = 1;
    KillTimer(g.hwnd, TIMER_CONFIRM);
    KillTimer(g.hwnd, TIMER_ICON);
    host_stop(&g.host, wait_ms);
    icon_remove();
    DestroyWindow(g.hwnd);
}

static LRESULT CALLBACK wnd_proc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp)
{
    if (g.taskbar_created != 0 && msg == g.taskbar_created) {
        /* Explorer restarted: the icon is gone and the scale may have changed. */
        g.icon_added = 0;
        g.icon_tries = 0;
        icons_load();
        icon_add();
        return 0;
    }
    switch (msg) {
    case WM_TRAY_ICON: on_icon(LOWORD(lp), wp); return 0;
    case WM_TRAY_LINE: {
        struct proto_line *pl = (struct proto_line *)lp;
        if ((UINT)wp == g.host.generation && !g.quitting) on_line(pl);
        free(pl);
        return 0;
    }
    case WM_TRAY_HOST_EOF:
        if ((UINT)wp == g.host.generation) on_host_eof();
        return 0;
    case WM_COPYDATA: return on_copydata((const COPYDATASTRUCT *)lp);
    case WM_TIMER:
        if (wp == TIMER_CONFIRM) {
            /* No answer from the host: Quit goes ahead, Stop panel is dropped. */
            KillTimer(hwnd, TIMER_CONFIRM);
            enum pending what = g.pending;
            g.pending = PENDING_NONE;
            if (what == PENDING_QUIT) act(what);
        } else if (wp == TIMER_ICON) {
            KillTimer(hwnd, TIMER_ICON);
            if (!g.icon_added && icon_add() && g.st == ST_ERROR) toast_error();
        }
        return 0;
    case WM_QUERYENDSESSION: return TRUE;
    case WM_ENDSESSION:
        if (wp) quit_now(TRAY_ENDSESSION_WAIT_MS);
        return 0;
    case WM_CLOSE: quit_now(TRAY_QUIT_WAIT_MS); return 0;
    case WM_DESTROY: PostQuitMessage(0); return 0;
    default: break;
    }
    return DefWindowProcW(hwnd, msg, wp, lp);
}

static HWND find_instance(DWORD wait_ms)
{
    ULONGLONG start = GetTickCount64();
    for (;;) {
        HWND w = FindWindowW(TRAY_WINDOW_CLASS, NULL);
        if (w != NULL || GetTickCount64() - start >= wait_ms) return w;
        Sleep(100);
    }
}

/* Sends "open" or "handoff" to the running copy; returns its reply, or -1. */
static int send_to_instance(HWND w, const wchar_t *word)
{
    COPYDATASTRUCT cd;
    cd.dwData = TRAY_COPYDATA_TAG;
    cd.cbData = (DWORD)(wcslen(word) * sizeof(wchar_t));
    cd.lpData = (PVOID)word;
    DWORD_PTR result = 0;
    if (!SendMessageTimeoutW(w, WM_COPYDATA, 0, (LPARAM)&cd, SMTO_ABORTIFHUNG | SMTO_BLOCK, 15000, &result)) return -1;
    return (int)result;
}

static int handoff(void)
{
    HANDLE m = OpenMutexW(SYNCHRONIZE, FALSE, MUTEX_NAME);
    if (m == NULL && GetLastError() != ERROR_ACCESS_DENIED) return self_start() ? 3 : 1;
    if (m != NULL) CloseHandle(m);
    HWND w = find_instance(FIND_WAIT_MS);
    if (w == NULL) return 1;
    int reply = send_to_instance(w, L"handoff");
    if (reply == TRAY_REPLY_OPENED) return 0;
    if (reply == TRAY_REPLY_ERROR) return 4;
    return 1;
}

static int run_instance(HINSTANCE inst, int background)
{
    HANDLE mutex = CreateMutexW(NULL, FALSE, MUTEX_NAME);
    if (mutex == NULL) return 1;
    if (GetLastError() == ERROR_ALREADY_EXISTS) {
        CloseHandle(mutex);
        if (!background) {
            HWND w = find_instance(FIND_WAIT_MS);
            if (w != NULL) send_to_instance(w, L"open");
        }
        return 0;
    }

    memset(&g, 0, sizeof g);
    g.inst = inst;
    g.background = background;
    g.st = ST_STARTING;

    INITCOMMONCONTROLSEX icc = { sizeof icc, ICC_STANDARD_CLASSES };
    InitCommonControlsEx(&icc);

    WNDCLASSEXW wc;
    memset(&wc, 0, sizeof wc);
    wc.cbSize = sizeof wc;
    wc.lpfnWndProc = wnd_proc;
    wc.hInstance = inst;
    wc.lpszClassName = TRAY_WINDOW_CLASS;
    if (!RegisterClassExW(&wc)) {
        CloseHandle(mutex);
        return 1;
    }
    g.taskbar_created = RegisterWindowMessageW(L"TaskbarCreated");
    /* Top-level and never shown, so it gets WM_QUERYENDSESSION, WM_ENDSESSION and TaskbarCreated. */
    g.hwnd = CreateWindowExW(WS_EX_TOOLWINDOW, TRAY_WINDOW_CLASS, L"GM-Scriptorium", WS_OVERLAPPED, 0, 0, 0, 0, NULL, NULL, inst, NULL);
    if (g.hwnd == NULL) {
        CloseHandle(mutex);
        return 1;
    }
    icons_load();
    icon_add();
    if (!host_spawn(&g.host, g.hwnd, background)) {
        enter_error(ERR_GONE, L"GM-Scriptorium could not start gm-scriptorium.exe from its install folder.");
    }
    icon_refresh();

    MSG msg;
    while (GetMessageW(&msg, NULL, 0, 0) > 0) {
        TranslateMessage(&msg);
        DispatchMessageW(&msg);
    }
    host_release(&g.host);
    icons_free();
    CloseHandle(mutex);
    return 0;
}

int WINAPI wWinMain(HINSTANCE inst, HINSTANCE prev, PWSTR cmdline, int show)
{
    (void)prev;
    (void)cmdline;
    (void)show;
    int argc = 0;
    LPWSTR *argv = CommandLineToArgvW(GetCommandLineW(), &argc);
    if (argv == NULL) return 1;
    int code = 1;
    if (argc == 1) {
        code = run_instance(inst, 0);
    } else if (argc == 2 && wcscmp(argv[1], L"--background") == 0) {
        code = run_instance(inst, 1);
    } else if (argc == 2 && wcscmp(argv[1], L"--handoff") == 0) {
        code = handoff();
    } else if (argc == 3 && wcscmp(argv[1], L"--autostart") == 0) {
        if (wcscmp(argv[2], L"on") == 0) code = autostart_set(1) ? 0 : 1;
        else if (wcscmp(argv[2], L"off") == 0) code = autostart_set(0) ? 0 : 1;
    }
    LocalFree(argv);
    return code;
}
