/*
 * host.c: the hidden GM-Scriptorium program the tray helper runs, and the line protocol on its
 * pipes (ADR 0057, section 3 and "Protocol v1").
 *
 * The first half is pure C with no Win32 call. test/tray-build.test.js compiles it for Linux with
 * TRAY_PURE_ONLY defined and checks it against src/desktop/protocol.js line for line. The second
 * half starts programs: the host itself and `desktop set` for the change-ports window. Both are
 * found beside this helper through GetModuleFileNameW, never on PATH.
 */
#include "tray.h"

#include <stdlib.h>
#include <string.h>

/* ---------------------------------------------------------------------------------------------
 * Protocol v1. These two tables are the only place a verb is spelt out; test/tray-structure
 * pins them to HOST_VERBS and HELPER_VERBS in src/desktop/protocol.js.
 * ------------------------------------------------------------------------------------------- */

static const char *const HOST_VERBS[] = { "hello", "state", "confirm", "update", "bye" };
static const char *const HELPER_VERBS[] = { "open", "stop?", "stop", "start", "restart", "retry", "quit?", "quit" };

_Static_assert(sizeof HOST_VERBS / sizeof HOST_VERBS[0] == HOST_VERB_COUNT, "the host verb table and enum agree");
_Static_assert(sizeof HELPER_VERBS / sizeof HELPER_VERBS[0] == HELPER_VERB_COUNT, "the helper verb table and enum agree");

#define TRAY_STR2(x) #x
#define TRAY_STR(x) TRAY_STR2(x)

const char *proto_host_verb(int verb)
{
    return verb >= 0 && verb < HOST_VERB_COUNT ? HOST_VERBS[verb] : "";
}

const char *proto_helper_verb(int verb)
{
    return verb >= 0 && verb < HELPER_VERB_COUNT ? HELPER_VERBS[verb] : "";
}

/* C0 controls and DEL, the bytes a sender strips and a receiver refuses (TAB aside). */
static int is_control(unsigned char c)
{
    return c < 0x20 || c == 0x7f;
}

/* Well-formed UTF-8: no overlong forms, no surrogates, nothing past U+10FFFF. */
static int utf8_valid(const unsigned char *s, size_t n)
{
    size_t i = 0;
    while (i < n) {
        unsigned c = s[i];
        size_t len;
        unsigned long cp;
        unsigned long min;
        if (c < 0x80) {
            i++;
            continue;
        }
        if ((c & 0xe0) == 0xc0) {
            len = 2;
            cp = c & 0x1f;
            min = 0x80;
        } else if ((c & 0xf0) == 0xe0) {
            len = 3;
            cp = c & 0x0f;
            min = 0x800;
        } else if ((c & 0xf8) == 0xf0) {
            len = 4;
            cp = c & 0x07;
            min = 0x10000;
        } else {
            return 0;
        }
        if (i + len > n) return 0;
        for (size_t k = 1; k < len; k++) {
            if ((s[i + k] & 0xc0) != 0x80) return 0;
            cp = (cp << 6) | (s[i + k] & 0x3f);
        }
        if (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return 0;
        i += len;
    }
    return 1;
}

static int find_verb(const char *const *table, int count, const char *word)
{
    for (int i = 0; i < count; i++) {
        if (strcmp(table[i], word) == 0) return i;
    }
    return -1;
}

/*
 * parseLine in src/desktop/protocol.js: a line over the limit (LF included) is dropped; one closing
 * LF is removed; an empty line, a CR, an embedded LF or any other control but TAB drops the line;
 * an unknown first field drops it. A missing closing LF is tolerated. Malformed UTF-8 is dropped
 * too, which the JS side never sees because it reads text.
 */
int proto_parse_line(const char *text, size_t len, struct proto_line *out)
{
    if (text == NULL || out == NULL || len > TRAY_MAX_LINE_BYTES) return 0;
    size_t body = len;
    if (body > 0 && text[body - 1] == '\n') body--;
    if (body == 0) return 0;
    for (size_t i = 0; i < body; i++) {
        unsigned char c = (unsigned char)text[i];
        if (c != '\t' && is_control(c)) return 0;
    }
    if (!utf8_valid((const unsigned char *)text, body)) return 0;

    memcpy(out->buf, text, body);
    out->buf[body] = '\0';
    char *tab = strchr(out->buf, '\t');
    if (tab != NULL) *tab = '\0';
    int verb = find_verb(HOST_VERBS, HOST_VERB_COUNT, out->buf);
    out->is_host = verb >= 0;
    if (verb < 0) verb = find_verb(HELPER_VERBS, HELPER_VERB_COUNT, out->buf);
    if (verb < 0) return 0;
    out->verb = verb;

    out->nargs = 0;
    for (size_t i = 0; i < TRAY_MAX_FIELDS; i++) out->args[i] = NULL;
    while (tab != NULL) {
        char *field = tab + 1;
        tab = strchr(field, '\t');
        if (tab != NULL) *tab = '\0';
        if (out->nargs < TRAY_MAX_FIELDS) out->args[out->nargs] = field;
        out->nargs++;
    }
    return 1;
}

/*
 * encodeLine in src/desktop/protocol.js: controls are stripped from every field first, then the
 * fields are joined by TAB and closed by LF, and a result over the limit is refused (-1).
 * Returns the length written, LF included; `out` also gets a closing NUL.
 */
int proto_encode_line(const char *const *fields, size_t n, char *out, size_t outsize)
{
    if (fields == NULL || n == 0 || out == NULL || outsize < TRAY_MAX_LINE_BYTES + 1) return -1;
    size_t pos = 0;
    for (size_t i = 0; i < n; i++) {
        if (i > 0) {
            if (pos + 1 >= TRAY_MAX_LINE_BYTES) return -1;
            out[pos++] = '\t';
        }
        const unsigned char *f = (const unsigned char *)(fields[i] != NULL ? fields[i] : "");
        for (; *f != '\0'; f++) {
            if (is_control(*f)) continue;
            if (pos + 1 >= TRAY_MAX_LINE_BYTES) return -1;
            out[pos++] = (char)*f;
        }
    }
    out[pos++] = '\n';
    out[pos] = '\0';
    return (int)pos;
}

void splitter_init(struct line_splitter *sp)
{
    sp->used = 0;
    sp->discarding = 0;
}

void splitter_feed(struct line_splitter *sp, const char *data, size_t n, line_sink sink, void *ctx)
{
    for (size_t i = 0; i < n; i++) {
        char c = data[i];
        if (sp->discarding) {
            if (c == '\n') sp->discarding = 0;
            continue;
        }
        if (sp->used >= TRAY_MAX_LINE_BYTES) {
            /* Already a full 1024 bytes with no LF: this line is over the limit. Drop it whole. */
            sp->used = 0;
            if (c != '\n') sp->discarding = 1;
            continue;
        }
        sp->line[sp->used++] = c;
        if (c == '\n') {
            sink(ctx, sp->line, sp->used);
            sp->used = 0;
        }
    }
}

void splitter_finish(struct line_splitter *sp, line_sink sink, void *ctx)
{
    if (!sp->discarding && sp->used > 0) sink(ctx, sp->line, sp->used);
    splitter_init(sp);
}

/* `hello` carries the protocol number and the app version; both must match exactly (Lead
 * amendment 4b). An old helper with a new program, or the reverse, fails here. */
int hello_matches(const char *protocol, const char *version)
{
    if (protocol == NULL || version == NULL) return 0;
    return strcmp(protocol, TRAY_STR(TRAY_PROTOCOL_VERSION)) == 0 && strcmp(version, TRAY_APP_VERSION) == 0;
}

static const char NOTES_PREFIX[] = "https://github.com/DrNoisys-Softworks/gm-scriptorium/releases/tag/v";

/* The update toast opens only a release page of this project:
 * ^https://github\.com/DrNoisys-Softworks/gm-scriptorium/releases/tag/v[0-9A-Za-z.-]{1,40}$ */
int notes_url_ok(const char *url)
{
    if (url == NULL) return 0;
    size_t p = sizeof NOTES_PREFIX - 1;
    if (strncmp(url, NOTES_PREFIX, p) != 0) return 0;
    size_t n = 0;
    for (const char *t = url + p; *t != '\0'; t++, n++) {
        char c = *t;
        int ok = (c >= '0' && c <= '9') || (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c == '.' || c == '-';
        if (!ok || n >= 40) return 0;
    }
    return n >= 1;
}

/* A port field holds 1 to 5 ASCII digits, checked before any command line is built (Lead
 * amendment 6). The range is the program's to judge. */
int port_field_ok(const wchar_t *text)
{
    if (text == NULL) return 0;
    size_t n = 0;
    for (; text[n] != L'\0'; n++) {
        if (text[n] < L'0' || text[n] > L'9' || n >= 5) return 0;
    }
    return n >= 1;
}

/* A drive path (C:\...) or a UNC path (\\server\...). */
int path_is_absolute(const wchar_t *path)
{
    if (path == NULL) return 0;
    wchar_t d = path[0];
    if (((d >= L'A' && d <= L'Z') || (d >= L'a' && d <= L'z')) && path[1] == L':' && path[2] == L'\\') return 1;
    return path[0] == L'\\' && path[1] == L'\\' && path[2] != L'\0' && path[2] != L'\\';
}

/* Copies at most cap - 1 units, never splitting a UTF-16 surrogate pair. */
void wtrunc(wchar_t *dst, size_t cap, const wchar_t *src)
{
    if (dst == NULL || cap == 0) return;
    if (src == NULL) src = L"";
    size_t n = 0;
    while (n + 1 < cap && src[n] != L'\0') {
        dst[n] = src[n];
        n++;
    }
    if (src[n] != L'\0' && n > 0 && dst[n - 1] >= 0xd800 && dst[n - 1] <= 0xdbff) n--;
    dst[n] = L'\0';
}

/*
 * Draws a state badge in the bottom-right corner of a top-down 32-bit ARGB icon image (frames T01
 * to T09: red with "!" for an error, blue for an update, grey for stopped, a ring for starting).
 * Works in doubled coordinates so pixel centres are whole numbers.
 */
void badge_paint(uint32_t *px, int w, int h, int kind)
{
    if (px == NULL || w < 8 || h < 8 || kind == BADGE_NONE) return;
    const uint32_t edge = 0xfff9f9f9u;
    uint32_t fill;
    switch (kind) {
    case BADGE_ERROR: fill = 0xffc42b1cu; break;
    case BADGE_UPDATE: fill = 0xff0f6cbdu; break;
    case BADGE_STOPPED: fill = 0xff8a8a8au; break;
    case BADGE_STARTING: fill = 0xffffffffu; break;
    default: return;
    }
    const int d = (w * 5 + 4) / 8;        /* badge diameter in pixels, = radius in doubled units */
    const int t = w / 16 > 1 ? w / 16 : 1; /* ring thickness in pixels */
    const int cx = 2 * w - d;
    const int cy = 2 * h - d;
    const int inner = d - 2 * t;
    for (int y = 0; y < h; y++) {
        for (int x = 0; x < w; x++) {
            const int dx = 2 * x + 1 - cx;
            const int dy = 2 * y + 1 - cy;
            int in_shape;
            int in_fill;
            if (kind == BADGE_STOPPED) {
                in_shape = abs(dx) < d && abs(dy) < d;
                in_fill = abs(dx) < inner && abs(dy) < inner;
            } else {
                in_shape = dx * dx + dy * dy < d * d;
                in_fill = dx * dx + dy * dy < inner * inner;
            }
            if (!in_shape) continue;
            uint32_t colour = in_fill ? fill : edge;
            if (kind == BADGE_STARTING && !in_fill) colour = dy < -abs(dx) ? 0xff0f6cbdu : 0xff8a8a8au;
            if (kind == BADGE_ERROR && in_fill && abs(dx) <= t) {
                /* the "!": a bar above the centre and a dot below it */
                if ((dy >= -(d * 55) / 100 && dy <= (d * 10) / 100) || (dy >= (d * 30) / 100 && dy <= (d * 55) / 100)) colour = 0xffffffffu;
            }
            px[y * w + x] = colour;
        }
    }
}

static wchar_t ascii_upper(wchar_t c)
{
    return c >= L'a' && c <= L'z' ? (wchar_t)(c - (L'a' - L'A')) : c;
}

/* Compares the name of "NAME=value" with `name`, case-insensitively (ASCII). */
static int env_name_cmp(const wchar_t *entry, const wchar_t *name)
{
    size_t i = 0;
    for (;; i++) {
        wchar_t a = entry[i] == L'=' || entry[i] == L'\0' ? L'\0' : ascii_upper(entry[i]);
        wchar_t b = ascii_upper(name[i]);
        if (a != b) return a < b ? -1 : 1;
        if (a == L'\0') return 0;
    }
}

/*
 * A copy of an environment block with `dir` first on PATH, for the command line window only
 * (ADR 0057 section 10). The existing name keeps its spelling; a block with no PATH gets one in
 * sorted position. Entries that start with "=" (per-drive folders) are left alone. Returns a
 * malloc'd block, or NULL.
 */
wchar_t *env_with_path_first(const wchar_t *block, const wchar_t *dir)
{
    if (block == NULL || dir == NULL) return NULL;
    size_t total = 0;
    int has_path = 0;
    for (const wchar_t *e = block; *e != L'\0'; e += wcslen(e) + 1) {
        total += wcslen(e) + 1;
        if (e[0] != L'=' && env_name_cmp(e, L"PATH") == 0) has_path = 1;
    }
    size_t dirlen = wcslen(dir);
    wchar_t *out = malloc((total + dirlen + 16) * sizeof(wchar_t));
    if (out == NULL) return NULL;
    wchar_t *w = out;
    int inserted = has_path;
    for (const wchar_t *e = block; *e != L'\0'; e += wcslen(e) + 1) {
        size_t len = wcslen(e);
        if (!inserted && e[0] != L'=' && env_name_cmp(e, L"PATH") > 0) {
            memcpy(w, L"PATH=", 5 * sizeof(wchar_t));
            w += 5;
            memcpy(w, dir, dirlen * sizeof(wchar_t));
            w += dirlen;
            *w++ = L'\0';
            inserted = 1;
        }
        if (e[0] != L'=' && env_name_cmp(e, L"PATH") == 0) {
            const wchar_t *eq = wcschr(e, L'=');
            size_t name = (size_t)(eq - e) + 1;
            memcpy(w, e, name * sizeof(wchar_t));
            w += name;
            memcpy(w, dir, dirlen * sizeof(wchar_t));
            w += dirlen;
            *w++ = L';';
            size_t rest = len - name;
            memcpy(w, eq + 1, rest * sizeof(wchar_t));
            w += rest;
            *w++ = L'\0';
        } else {
            memcpy(w, e, (len + 1) * sizeof(wchar_t));
            w += len + 1;
        }
    }
    if (!inserted) {
        memcpy(w, L"PATH=", 5 * sizeof(wchar_t));
        w += 5;
        memcpy(w, dir, dirlen * sizeof(wchar_t));
        w += dirlen;
        *w++ = L'\0';
    }
    *w = L'\0';
    return out;
}

/*
 * The signin= field of a state running line (ADR 0057 section 7, "Protocol v1"): 1 for
 * signin=confirmed, 0 for signin=unconfirmed. `args` are the fields after the verb, so the trailing
 * fields start after the address, at index 4. Each is found by its exact text and anything else is
 * ignored; if the field comes twice the last one counts. An older host that sends no such field is
 * read as unconfirmed.
 */
int signin_confirmed(const char *const *args, size_t nargs)
{
    int confirmed = 0;
    for (size_t i = 4; args != NULL && i < nargs; i++) {
        if (args[i] == NULL) continue;
        if (strcmp(args[i], "signin=confirmed") == 0) confirmed = 1;
        else if (strcmp(args[i], "signin=unconfirmed") == 0) confirmed = 0;
    }
    return confirmed;
}

/*
 * Which line goes under a ticked Start with Windows (owner rulings T03 and T03b). A local-only start
 * at sign-in, or a remote panel whose sign-in start is not confirmed for this PC, gets "set up ...
 * until you confirm"; a remote panel confirmed for sign-in gets "on, including at sign-in".
 */
int t03_line(int autostart, int signin_local, int remote, int confirmed)
{
    if (!autostart) return T03_NONE;
    if (signin_local) return T03_UNCONFIRMED;
    if (!remote) return T03_NONE;
    return confirmed ? T03_CONFIRMED : T03_UNCONFIRMED;
}

#ifndef TRAY_PURE_ONLY

/* ---------------------------------------------------------------------------------------------
 * Win32: starting the program and talking to it
 * ------------------------------------------------------------------------------------------- */

#define TRAY_PATH_CAP 32768
#define TRAY_STDERR_RING 8192

/* Appends src to dst; returns 0 when it would not fit. */
static int wappend(wchar_t *dst, size_t cap, const wchar_t *src)
{
    size_t a = wcslen(dst);
    size_t b = wcslen(src);
    if (a + b + 1 > cap) return 0;
    memcpy(dst + a, src, (b + 1) * sizeof(wchar_t));
    return 1;
}

/* The folder this helper runs from, from GetModuleFileNameW. */
int own_dir(wchar_t *dir, size_t cap)
{
    DWORD n = GetModuleFileNameW(NULL, dir, (DWORD)cap);
    if (n == 0 || n >= cap) return 0;
    wchar_t *slash = wcsrchr(dir, L'\\');
    if (slash == NULL) return 0;
    *slash = L'\0';
    return 1;
}

/* "<own folder>\gm-scriptorium.exe", the program beside this helper. */
static int program_path(wchar_t *path, size_t cap)
{
    return own_dir(path, cap) && wappend(path, cap, L"\\gm-scriptorium.exe");
}

/* %USERPROFILE%, the working folder for everything this helper starts; NULL to inherit. */
const wchar_t *user_profile(void)
{
    static wchar_t buf[MAX_PATH * 2];
    DWORD n = GetEnvironmentVariableW(L"USERPROFILE", buf, MAX_PATH * 2);
    return n > 0 && n < MAX_PATH * 2 ? buf : NULL;
}

wchar_t *utf8_to_wide(const char *s)
{
    if (s == NULL) return NULL;
    int n = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, s, -1, NULL, 0);
    if (n <= 0) return NULL;
    wchar_t *w = malloc((size_t)n * sizeof(wchar_t));
    if (w == NULL) return NULL;
    if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, s, -1, w, n) != n) {
        free(w);
        return NULL;
    }
    return w;
}

/* An attribute list that limits what a child inherits to exactly these handles. */
static LPPROC_THREAD_ATTRIBUTE_LIST inherit_only(HANDLE *handles, size_t count)
{
    SIZE_T size = 0;
    InitializeProcThreadAttributeList(NULL, 1, 0, &size);
    LPPROC_THREAD_ATTRIBUTE_LIST list = HeapAlloc(GetProcessHeap(), 0, size);
    if (list == NULL) return NULL;
    if (!InitializeProcThreadAttributeList(list, 1, 0, &size)) {
        HeapFree(GetProcessHeap(), 0, list);
        return NULL;
    }
    if (!UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, handles, count * sizeof(HANDLE), NULL, NULL)) {
        DeleteProcThreadAttributeList(list);
        HeapFree(GetProcessHeap(), 0, list);
        return NULL;
    }
    return list;
}

static void inherit_free(LPPROC_THREAD_ATTRIBUTE_LIST list)
{
    if (list == NULL) return;
    DeleteProcThreadAttributeList(list);
    HeapFree(GetProcessHeap(), 0, list);
}

struct reader_ctx {
    HANDLE pipe;
    HWND notify;
    UINT generation;
    struct line_splitter sp;
};

static void reader_sink(void *arg, const char *line, size_t len)
{
    struct reader_ctx *c = arg;
    struct proto_line *pl = malloc(sizeof *pl);
    if (pl == NULL) return;
    if (!proto_parse_line(line, len, pl) || !PostMessageW(c->notify, WM_TRAY_LINE, c->generation, (LPARAM)pl)) free(pl);
}

/* Reads the host's output, posting each well-formed line to the window; end of output is posted
 * last, so the window sees every line before it. */
static DWORD WINAPI reader_main(LPVOID arg)
{
    struct reader_ctx *c = arg;
    char chunk[512];
    DWORD n = 0;
    splitter_init(&c->sp);
    while (ReadFile(c->pipe, chunk, sizeof chunk, &n, NULL) && n > 0) splitter_feed(&c->sp, chunk, n, reader_sink, c);
    splitter_finish(&c->sp, reader_sink, c);
    CloseHandle(c->pipe);
    PostMessageW(c->notify, WM_TRAY_HOST_EOF, c->generation, 0);
    free(c);
    return 0;
}

struct drain_ctx {
    HANDLE pipe;
    size_t at;
    char ring[TRAY_STDERR_RING];
};

/* The host's standard error, read so the pipe can never fill and stall it, kept in a ring and
 * thrown away (Lead amendment 6): never shown, never written to disk or the registry. */
static DWORD WINAPI stderr_drain_main(LPVOID arg)
{
    struct drain_ctx *c = arg;
    char chunk[512];
    DWORD n = 0;
    while (ReadFile(c->pipe, chunk, sizeof chunk, &n, NULL) && n > 0) {
        for (DWORD i = 0; i < n; i++) {
            c->ring[c->at] = chunk[i];
            c->at = (c->at + 1) % TRAY_STDERR_RING;
        }
    }
    CloseHandle(c->pipe);
    SecureZeroMemory(c->ring, sizeof c->ring);
    free(c);
    return 0;
}

/*
 * Starts "<own folder>\gm-scriptorium.exe desktop run [--background]" with no console at all
 * (DETACHED_PROCESS, not CREATE_NO_WINDOW: ADR 0057 section 3), its standard input, output and
 * error on pipes, the inherited environment and %USERPROFILE% as its folder.
 */
int host_spawn(struct host *h, HWND notify, int background)
{
    static wchar_t app[TRAY_PATH_CAP];
    static wchar_t cmd[TRAY_PATH_CAP];
    if (!program_path(app, TRAY_PATH_CAP)) return 0;
    cmd[0] = L'\0';
    if (!wappend(cmd, TRAY_PATH_CAP, L"\"") || !wappend(cmd, TRAY_PATH_CAP, app) || !wappend(cmd, TRAY_PATH_CAP, L"\"") ||
        !wappend(cmd, TRAY_PATH_CAP, L" desktop run") || (background && !wappend(cmd, TRAY_PATH_CAP, L" --background"))) {
        return 0;
    }

    SECURITY_ATTRIBUTES sa = { sizeof sa, NULL, TRUE };
    HANDLE in_r = NULL, in_w = NULL, out_r = NULL, out_w = NULL, err_r = NULL, err_w = NULL;
    if (!CreatePipe(&in_r, &in_w, &sa, 0)) return 0;
    if (!CreatePipe(&out_r, &out_w, &sa, 0)) {
        CloseHandle(in_r);
        CloseHandle(in_w);
        return 0;
    }
    if (!CreatePipe(&err_r, &err_w, &sa, 0)) {
        CloseHandle(in_r);
        CloseHandle(in_w);
        CloseHandle(out_r);
        CloseHandle(out_w);
        return 0;
    }
    SetHandleInformation(in_w, HANDLE_FLAG_INHERIT, 0);
    SetHandleInformation(out_r, HANDLE_FLAG_INHERIT, 0);
    SetHandleInformation(err_r, HANDLE_FLAG_INHERIT, 0);

    HANDLE inherit[3] = { in_r, out_w, err_w };
    LPPROC_THREAD_ATTRIBUTE_LIST list = inherit_only(inherit, 3);
    STARTUPINFOEXW si;
    memset(&si, 0, sizeof si);
    si.StartupInfo.cb = sizeof si;
    si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    si.StartupInfo.hStdInput = in_r;
    si.StartupInfo.hStdOutput = out_w;
    si.StartupInfo.hStdError = err_w;
    si.lpAttributeList = list;
    PROCESS_INFORMATION pi;
    memset(&pi, 0, sizeof pi);
    DWORD flags = DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_UNICODE_ENVIRONMENT | (list != NULL ? EXTENDED_STARTUPINFO_PRESENT : 0);
    BOOL ok = CreateProcessW(app, cmd, NULL, NULL, TRUE, flags, NULL, user_profile(), &si.StartupInfo, &pi);
    inherit_free(list);
    CloseHandle(in_r);
    CloseHandle(out_w);
    CloseHandle(err_w);
    if (!ok) {
        CloseHandle(in_w);
        CloseHandle(out_r);
        CloseHandle(err_r);
        return 0;
    }
    CloseHandle(pi.hThread);

    h->process = pi.hProcess;
    h->in_write = in_w;
    h->notify = notify;
    h->generation++;

    struct reader_ctx *rc = malloc(sizeof *rc);
    struct drain_ctx *dc = malloc(sizeof *dc);
    if (rc != NULL) {
        rc->pipe = out_r;
        rc->notify = notify;
        rc->generation = h->generation;
        h->reader = CreateThread(NULL, 0, reader_main, rc, 0, NULL);
    }
    if (rc == NULL || h->reader == NULL) {
        free(rc);
        CloseHandle(out_r);
        PostMessageW(notify, WM_TRAY_HOST_EOF, h->generation, 0);
    }
    if (dc != NULL) {
        dc->pipe = err_r;
        dc->at = 0;
        h->drain = CreateThread(NULL, 0, stderr_drain_main, dc, 0, NULL);
    }
    if (dc == NULL || h->drain == NULL) {
        free(dc);
        CloseHandle(err_r);
    }
    return 1;
}

int host_alive(const struct host *h)
{
    return h->process != NULL && WaitForSingleObject(h->process, 0) == WAIT_TIMEOUT;
}

/* Writes one helper line, with an optional argument. */
int host_send(struct host *h, int helper_verb, const char *arg)
{
    if (h->in_write == NULL) return 0;
    const char *fields[2] = { proto_helper_verb(helper_verb), arg };
    char line[TRAY_MAX_LINE_BYTES + 1];
    int len = proto_encode_line(fields, arg != NULL ? 2 : 1, line, sizeof line);
    if (len < 0) return 0;
    DWORD wrote = 0;
    return WriteFile(h->in_write, line, (DWORD)len, &wrote, NULL) && wrote == (DWORD)len;
}

/* Quit, then end of input (which also means quit), then wait; TerminateProcess after wait_ms. */
void host_stop(struct host *h, DWORD wait_ms)
{
    if (h->in_write != NULL) {
        host_send(h, HELPER_QUIT, NULL);
        CloseHandle(h->in_write);
        h->in_write = NULL;
    }
    if (h->process != NULL && WaitForSingleObject(h->process, wait_ms) != WAIT_OBJECT_0) {
        TerminateProcess(h->process, 1);
        WaitForSingleObject(h->process, 1000);
    }
}

/* Lets go of a host that has ended. The reader and drain threads close their own pipes. */
void host_release(struct host *h)
{
    if (h->in_write != NULL) CloseHandle(h->in_write);
    if (h->process != NULL) CloseHandle(h->process);
    if (h->reader != NULL) CloseHandle(h->reader);
    if (h->drain != NULL) CloseHandle(h->drain);
    h->in_write = NULL;
    h->process = NULL;
    h->reader = NULL;
    h->drain = NULL;
}

/*
 * The change-ports window's Save (frame T10, ADR 0057 section 8): runs
 * "<own folder>\gm-scriptorium.exe desktop set --port A --preview-port B" with no window, waits
 * up to 15 seconds, and returns its exit code (-1 when the fields are not 1 to 5 digits or it
 * could not start, -2 on a timeout). `first_line` gets the first line it printed.
 */
int desktop_set_run(const wchar_t *panel, const wchar_t *preview, wchar_t *first_line, size_t cap)
{
    if (first_line != NULL && cap > 0) first_line[0] = L'\0';
    if (!port_field_ok(panel) || !port_field_ok(preview)) return -1;

    static wchar_t app[TRAY_PATH_CAP];
    static wchar_t cmd[TRAY_PATH_CAP];
    if (!program_path(app, TRAY_PATH_CAP)) return -1;
    cmd[0] = L'\0';
    if (!wappend(cmd, TRAY_PATH_CAP, L"\"") || !wappend(cmd, TRAY_PATH_CAP, app) || !wappend(cmd, TRAY_PATH_CAP, L"\"") ||
        !wappend(cmd, TRAY_PATH_CAP, L" desktop set --port ") || !wappend(cmd, TRAY_PATH_CAP, panel) ||
        !wappend(cmd, TRAY_PATH_CAP, L" --preview-port ") || !wappend(cmd, TRAY_PATH_CAP, preview)) {
        return -1;
    }

    SECURITY_ATTRIBUTES sa = { sizeof sa, NULL, TRUE };
    HANDLE out_r = NULL, out_w = NULL;
    if (!CreatePipe(&out_r, &out_w, &sa, 0)) return -1;
    SetHandleInformation(out_r, HANDLE_FLAG_INHERIT, 0);
    HANDLE nul = CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, &sa, OPEN_EXISTING, 0, NULL);
    if (nul == INVALID_HANDLE_VALUE) {
        CloseHandle(out_r);
        CloseHandle(out_w);
        return -1;
    }
    HANDLE inherit[2] = { nul, out_w };
    LPPROC_THREAD_ATTRIBUTE_LIST list = inherit_only(inherit, 2);
    STARTUPINFOEXW si;
    memset(&si, 0, sizeof si);
    si.StartupInfo.cb = sizeof si;
    si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    si.StartupInfo.hStdInput = nul;
    si.StartupInfo.hStdOutput = out_w;
    si.StartupInfo.hStdError = out_w;
    si.lpAttributeList = list;
    PROCESS_INFORMATION pi;
    memset(&pi, 0, sizeof pi);
    DWORD flags = CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT | (list != NULL ? EXTENDED_STARTUPINFO_PRESENT : 0);
    BOOL ok = CreateProcessW(app, cmd, NULL, NULL, TRUE, flags, NULL, user_profile(), &si.StartupInfo, &pi);
    inherit_free(list);
    CloseHandle(out_w);
    CloseHandle(nul);
    if (!ok) {
        CloseHandle(out_r);
        return -1;
    }
    CloseHandle(pi.hThread);

    char out[4096];
    size_t used = 0;
    int timed_out = 0;
    ULONGLONG start = GetTickCount64();
    for (int exited = 0;;) {
        DWORD avail = 0;
        while (PeekNamedPipe(out_r, NULL, 0, NULL, &avail, NULL) && avail > 0) {
            char chunk[512];
            DWORD got = 0;
            if (!ReadFile(out_r, chunk, avail < sizeof chunk ? avail : sizeof chunk, &got, NULL) || got == 0) break;
            for (DWORD i = 0; i < got && used + 1 < sizeof out; i++) out[used++] = chunk[i];
        }
        if (exited) break;
        if (WaitForSingleObject(pi.hProcess, 50) == WAIT_OBJECT_0) {
            exited = 1;
            continue;
        }
        if (GetTickCount64() - start > TRAY_DESKTOP_SET_WAIT_MS) {
            TerminateProcess(pi.hProcess, 1);
            WaitForSingleObject(pi.hProcess, 1000);
            timed_out = 1;
            break;
        }
    }
    DWORD code = 1;
    int result;
    if (timed_out) {
        result = -2;
    } else if (GetExitCodeProcess(pi.hProcess, &code)) {
        result = (int)code;
    } else {
        result = -1;
    }
    CloseHandle(pi.hProcess);
    CloseHandle(out_r);

    out[used] = '\0';
    char *line = out;
    while (*line == '\r' || *line == '\n') line++;
    line[strcspn(line, "\r\n")] = '\0';
    if (first_line != NULL && cap > 0 && *line != '\0') {
        wchar_t *w = utf8_to_wide(line);
        if (w != NULL) {
            wtrunc(first_line, cap, w);
            free(w);
        }
    }
    return result;
}

#endif /* TRAY_PURE_ONLY */
