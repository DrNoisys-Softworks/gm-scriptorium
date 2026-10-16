/*
 * gm-scriptorium-tray.exe, the Windows tray helper (ADR 0057, "The Windows desktop app").
 *
 * C17 against Win32 only, built by scripts/tray.js with mingw-w64. tray.c owns the icon, the
 * menu, the toasts, the single instance and Start with Windows; host.c owns the hidden
 * GM-Scriptorium program it runs, the line protocol on that program's pipes, and the pure
 * helpers that test/tray-build.test.js compiles for Linux with TRAY_PURE_ONLY defined.
 *
 * This header is also read by windres (RC_INVOKED), which needs only the resource ids.
 */
#ifndef GM_SCRIPTORIUM_TRAY_H
#define GM_SCRIPTORIUM_TRAY_H

/* Resource ids, shared with tray-dialogs.rc. */
#define IDI_LANTERN 1
#define IDD_PORTS 100
#define IDC_PORTS_ICON 101
#define IDC_PORTS_TITLE 102
#define IDC_PORT_PANEL 103
#define IDC_PORT_PREVIEW 104
#define IDC_PORTS_NOTE 105
#define IDC_PORTS_ERROR 106

#ifndef RC_INVOKED

#ifndef TRAY_APP_VERSION
#error "TRAY_APP_VERSION must be defined by the build (scripts/tray.js)"
#endif

#define TRAY_WIDEN2(x) L##x
#define TRAY_WIDEN(x) TRAY_WIDEN2(x)
#define TRAY_APP_VERSION_W TRAY_WIDEN(TRAY_APP_VERSION)

/* Protocol v1 (ADR 0057, "Protocol v1"). The verb tables are in host.c; a parity test pins
 * these numbers and those tables to src/desktop/protocol.js. */
#define TRAY_PROTOCOL_VERSION 1
#define TRAY_MAX_LINE_BYTES 1024
#define TRAY_MAX_FIELDS 8

/* Single instance (ADR 0057 section 4). */
#define TRAY_WINDOW_CLASS L"GMScriptoriumTray"
#define TRAY_COPYDATA_TAG 0x47534354
#define TRAY_REPLY_REFUSED 0
#define TRAY_REPLY_OPENED 1
#define TRAY_REPLY_ERROR 2

/* End of session (ADR 0057 section 6), and a Quit the GM or Setup asks for. */
#define TRAY_ENDSESSION_WAIT_MS 4000
#define TRAY_QUIT_WAIT_MS 10000

/* `desktop set` from the change-ports window (ADR 0057 section 8). */
#define TRAY_DESKTOP_SET_WAIT_MS 15000

#include <stddef.h>
#include <stdint.h>
#include <wchar.h>

#ifndef TRAY_PURE_ONLY
#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#undef _WIN32_WINNT
#define _WIN32_WINNT 0x0A00
#undef WINVER
#define WINVER 0x0A00
#undef NTDDI_VERSION
#define NTDDI_VERSION 0x0A000000
#include <windows.h>
#include <shellapi.h>
#include <commctrl.h>
#endif

enum host_verb { HOST_HELLO, HOST_STATE, HOST_CONFIRM, HOST_UPDATE, HOST_BYE, HOST_VERB_COUNT };
enum helper_verb {
    HELPER_OPEN,
    HELPER_STOP_ASK,
    HELPER_STOP,
    HELPER_START,
    HELPER_RESTART,
    HELPER_RETRY,
    HELPER_QUIT_ASK,
    HELPER_QUIT,
    HELPER_VERB_COUNT
};

/* One parsed line. args point into buf; nargs counts every argument, even past TRAY_MAX_FIELDS. */
struct proto_line {
    int is_host;
    int verb;
    size_t nargs;
    char *args[TRAY_MAX_FIELDS];
    char buf[TRAY_MAX_LINE_BYTES + 1];
};

/* Splits a byte stream into lines of at most TRAY_MAX_LINE_BYTES, LF included. A longer line is
 * dropped whole. splitter_finish passes on a last line that has no LF. */
struct line_splitter {
    char line[TRAY_MAX_LINE_BYTES + 1];
    size_t used;
    int discarding;
};
typedef void (*line_sink)(void *ctx, const char *line, size_t len);

/* The line under Start with Windows (owner rulings T03 and T03b), chosen by t03_line(). */
enum t03_choice { T03_NONE, T03_UNCONFIRMED, T03_CONFIRMED };

/* Badge kinds drawn on the icon (frames T01 to T09). */
enum badge_kind { BADGE_NONE, BADGE_STARTING, BADGE_ERROR, BADGE_UPDATE, BADGE_STOPPED };

/* ---- host.c, pure (no Win32) ---- */
const char *proto_host_verb(int verb);
const char *proto_helper_verb(int verb);
int proto_parse_line(const char *text, size_t len, struct proto_line *out);
int proto_encode_line(const char *const *fields, size_t n, char *out, size_t outsize);
void splitter_init(struct line_splitter *sp);
void splitter_feed(struct line_splitter *sp, const char *data, size_t n, line_sink sink, void *ctx);
void splitter_finish(struct line_splitter *sp, line_sink sink, void *ctx);
int hello_matches(const char *protocol, const char *version);
int notes_url_ok(const char *url);
int port_field_ok(const wchar_t *text);
int path_is_absolute(const wchar_t *path);
void wtrunc(wchar_t *dst, size_t cap, const wchar_t *src);
void badge_paint(uint32_t *pixels, int w, int h, int kind);
wchar_t *env_with_path_first(const wchar_t *block, const wchar_t *dir);
int signin_confirmed(const char *const *args, size_t nargs);
int t03_line(int autostart, int signin_local, int remote, int confirmed);

#ifndef TRAY_PURE_ONLY

#define WM_TRAY_LINE (WM_APP + 2)
#define WM_TRAY_HOST_EOF (WM_APP + 3)

/* The hidden program and its pipes. */
struct host {
    HANDLE process;
    HANDLE in_write;
    HANDLE out_read;
    HANDLE err_read;
    HANDLE reader;
    HANDLE drain;
    HWND notify;
    UINT generation;
};

/* ---- host.c, Win32 ---- */
int own_dir(wchar_t *dir, size_t cap);
const wchar_t *user_profile(void);
int host_spawn(struct host *h, HWND notify, int background);
int host_alive(const struct host *h);
int host_send(struct host *h, int helper_verb, const char *arg);
void host_stop(struct host *h, DWORD wait_ms);
void host_release(struct host *h);
int desktop_set_run(const wchar_t *panel, const wchar_t *preview, wchar_t *first_line, size_t cap);
wchar_t *utf8_to_wide(const char *s);

#endif /* TRAY_PURE_ONLY */
#endif /* RC_INVOKED */
#endif /* GM_SCRIPTORIUM_TRAY_H */
