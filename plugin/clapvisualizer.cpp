#include <clap/clap.h>
#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <charconv>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <mutex>
#include <string>
#include <thread>
#include <vector>
#include <arpa/inet.h>
#include <cairo/cairo-xcb.h>
#include <dlfcn.h>
#include <fcntl.h>
#include <ifaddrs.h>
#include <net/if.h>
#include <poll.h>
#include <qrencode.h>
#include <signal.h>
#include <spawn.h>
#include <sys/wait.h>
#include <xcb/xcb.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <unistd.h>

namespace {
constexpr size_t Limit = 65536, RingSize = 16384, Samples = 1024, QueueLimit = 262144, PcmBacklog = 96000;
static_assert(std::atomic<double>::is_always_lock_free && std::atomic<uint64_t>::is_always_lock_free &&
              std::atomic<uint32_t>::is_always_lock_free && std::atomic<bool>::is_always_lock_free);

uint32_t rotate(uint32_t n, int bits) { return (n << bits) | (n >> (32 - bits)); }
std::string acceptKey(const std::string &key) {
    std::string data = key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
    uint64_t bits = data.size() * 8;
    data += char(0x80);
    while (data.size() % 64 != 56) data += '\0';
    for (int i = 7; i >= 0; --i) data += char(bits >> (i * 8));
    uint32_t h[5] = {0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0};
    for (size_t pos = 0; pos < data.size(); pos += 64) {
        uint32_t w[80]{};
        for (int i = 0; i < 16; ++i)
            for (int j = 0; j < 4; ++j) w[i] = (w[i] << 8) | uint8_t(data[pos + i * 4 + j]);
        for (int i = 16; i < 80; ++i) w[i] = rotate(w[i-3] ^ w[i-8] ^ w[i-14] ^ w[i-16], 1);
        uint32_t a=h[0], b=h[1], c=h[2], d=h[3], e=h[4];
        for (int i = 0; i < 80; ++i) {
            uint32_t f, k;
            if (i < 20) { f = (b & c) | (~b & d); k = 0x5a827999; }
            else if (i < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
            else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
            else { f = b ^ c ^ d; k = 0xca62c1d6; }
            uint32_t t = rotate(a, 5) + f + e + k + w[i];
            e=d; d=c; c=rotate(b,30); b=a; a=t;
        }
        h[0]+=a; h[1]+=b; h[2]+=c; h[3]+=d; h[4]+=e;
    }
    unsigned char digest[20];
    for (int i=0; i<20; ++i) digest[i] = h[i/4] >> (24 - 8*(i%4));
    constexpr char alphabet[]="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string out;
    for (int i=0; i<20; i+=3) {
        uint32_t n = uint32_t(digest[i]) << 16;
        if (i+1<20) n |= uint32_t(digest[i+1]) << 8;
        if (i+2<20) n |= digest[i+2];
        out += alphabet[n >> 18]; out += alphabet[(n >> 12) & 63];
        out += i+1<20 ? alphabet[(n >> 6) & 63] : '=';
        out += i+2<20 ? alphabet[n & 63] : '=';
    }
    return out;
}
std::string frame(int op, const std::string &payload) {
    std::string out(1, char(0x80 | op));
    size_t n=payload.size();
    if (n<126) out += char(n);
    else if (n<=65535) { out += char(126); out += char(n >> 8); out += char(n); }
    else { out += char(127); for (int i=7; i>=0; --i) out += char(uint64_t(n) >> (8*i)); }
    return out + payload;
}
bool utf8(const std::string &s) {
    for (size_t i=0; i<s.size();) {
        uint8_t c=s[i++];
        if (c<0x80) continue;
        int n; uint32_t cp, min;
        if (c>=0xc2 && c<=0xdf) { n=1; cp=c&31; min=0x80; }
        else if (c>=0xe0 && c<=0xef) { n=2; cp=c&15; min=0x800; }
        else if (c>=0xf0 && c<=0xf4) { n=3; cp=c&7; min=0x10000; }
        else return false;
        if (i+n>s.size()) return false;
        while (n--) { uint8_t b=s[i++]; if ((b&0xc0)!=0x80) return false; cp=(cp<<6)|(b&63); }
        if (cp<min || cp>0x10ffff || (cp>=0xd800 && cp<=0xdfff)) return false;
    }
    return true;
}
std::string lower(std::string s) { for (char &c:s) if (c>='A' && c<='Z') c+=32; return s; }
std::string trim(const std::string &s) {
    size_t a=s.find_first_not_of(" \t"), b=s.find_last_not_of(" \t");
    return a==std::string::npos ? "" : s.substr(a,b-a+1);
}
bool token(const std::string &s, const char *wanted) {
    size_t pos=0;
    do { size_t end=s.find(',',pos); if (lower(trim(s.substr(pos,end-pos)))==wanted) return true;
         if (end==std::string::npos) break;
         pos=end+1; } while (true);
    return false;
}
const char *mime(const std::string &path) {
    std::string ext=lower(path.substr(path.find_last_of('.')+1));
    if (ext=="html") return "text/html; charset=utf-8";
    if (ext=="js" || ext=="mjs") return "text/javascript; charset=utf-8";
    if (ext=="css") return "text/css; charset=utf-8";
    if (ext=="json") return "application/json";
    if (ext=="svg") return "image/svg+xml";
    if (ext=="png") return "image/png";
    if (ext=="jpg" || ext=="jpeg") return "image/jpeg";
    if (ext=="webp") return "image/webp";
    if (ext=="ico") return "image/x-icon";
    if (ext=="wasm") return "application/wasm";
    return "application/octet-stream";
}
std::string number(double value) {
    char text[64];
    auto result=std::to_chars(text,text+sizeof(text),value);
    return {text,result.ptr};
}
using Clock=std::chrono::steady_clock;
int configuredPort() {
    if (const char *env=std::getenv("VSTVIS_PORT")) { char *end=nullptr; long n=std::strtol(env,&end,10); if (*env && !*end && n>0 && n<=65535) return n; std::fprintf(stderr,"CLAP Visualizer: invalid VSTVIS_PORT; using 8765\n"); }
    return 8765;
}
// One line of the plugin window; rows with a url are clickable links.
struct Row { std::string text, url; };
constexpr int GuiWidth=720, GuiLine=26, GuiPad=16, QrSize=152, QrLabel=30;
// The two rows below the links: a switch and the public address of the Cloudflare tunnel.
const char TunnelToggle[]="tunnel:toggle", TunnelOpen[]="tunnel:open", TunnelCopy[]="tunnel:copy";
// Paints the picture for sharing the internet link (1080×1350, fits a chat bubble) and writes it as PNG.
bool shareCard(const std::string &url,const std::string &path) {
    QRcode *code=QRcode_encodeString8bit(url.c_str(),0,QR_ECLEVEL_M);
    if (!code) return false;
    const double W=1080,H=1350;
    cairo_surface_t *surface=cairo_image_surface_create(CAIRO_FORMAT_RGB24,int(W),int(H));
    cairo_t *cr=cairo_create(surface);
    auto fill=[&](cairo_pattern_t *pattern) { cairo_set_source(cr,pattern); cairo_paint(cr); cairo_pattern_destroy(pattern); };
    auto glow=[&](double x,double y,double radius,double r,double g,double b,double alpha) {
        cairo_pattern_t *pattern=cairo_pattern_create_radial(x,y,0,x,y,radius);
        cairo_pattern_add_color_stop_rgba(pattern,0,r,g,b,alpha); cairo_pattern_add_color_stop_rgba(pattern,1,r,g,b,0); fill(pattern);
    };
    auto rounded=[&](double x,double y,double w,double h,double radius) {
        const double quarter=1.5707963267948966;
        cairo_new_sub_path(cr);
        cairo_arc(cr,x+w-radius,y+radius,radius,-quarter,0); cairo_arc(cr,x+w-radius,y+h-radius,radius,0,quarter);
        cairo_arc(cr,x+radius,y+h-radius,radius,quarter,2*quarter); cairo_arc(cr,x+radius,y+radius,radius,2*quarter,3*quarter);
        cairo_close_path(cr);
    };
    // Draws centred text and returns its width.
    auto text=[&](const std::string &s,double y,double size,bool bold,double r,double g,double b) {
        cairo_select_font_face(cr,"sans-serif",CAIRO_FONT_SLANT_NORMAL,bold ? CAIRO_FONT_WEIGHT_BOLD : CAIRO_FONT_WEIGHT_NORMAL);
        cairo_set_font_size(cr,size);
        cairo_text_extents_t extents; cairo_text_extents(cr,s.c_str(),&extents);
        cairo_set_source_rgb(cr,r,g,b); cairo_move_to(cr,(W-extents.x_advance)/2,y); cairo_show_text(cr,s.c_str());
        return extents.x_advance;
    };
    cairo_pattern_t *back=cairo_pattern_create_linear(0,0,0,H);
    cairo_pattern_add_color_stop_rgb(back,0,0.06,0.08,0.16); cairo_pattern_add_color_stop_rgb(back,1,0.027,0.043,0.07); fill(back);
    glow(W*0.9,H*0.08,760,0.22,0.74,0.97,0.30); glow(W*0.05,H*0.95,820,0.66,0.33,0.97,0.28);

    // Title in two colours, centred as one line.
    cairo_select_font_face(cr,"sans-serif",CAIRO_FONT_SLANT_NORMAL,CAIRO_FONT_WEIGHT_BOLD); cairo_set_font_size(cr,84);
    cairo_text_extents_t first,second; cairo_text_extents(cr,"CLAP ",&first); cairo_text_extents(cr,"Visualizer",&second);
    double left=(W-first.x_advance-second.x_advance)/2;
    cairo_set_source_rgb(cr,0.94,0.96,1); cairo_move_to(cr,left,170); cairo_show_text(cr,"CLAP ");
    cairo_set_source_rgb(cr,0.22,0.74,0.97); cairo_show_text(cr,"Visualizer");
    text("L I V E   V I S U A L S   ·   Y O U R   T O U C H",232,24,false,0.61,0.67,0.75);

    // White card with a soft shadow; the code keeps square modules so every phone reads it.
    const double card=720,cardX=(W-card)/2,cardY=300;
    for (int i=12;i>0;--i) { rounded(cardX-i*3,cardY-i*3+18,card+i*6,card+i*6,56+i*3); cairo_set_source_rgba(cr,0,0,0,0.035); cairo_fill(cr); }
    rounded(cardX,cardY,card,card,56); cairo_set_source_rgb(cr,1,1,1); cairo_fill(cr);
    int module=int((card-90)/code->width); double origin=(card-module*code->width)/2;
    cairo_set_source_rgb(cr,0.04,0.06,0.13);
    for (int y=0;y<code->width;++y) for (int x=0;x<code->width;++x)
        if (code->data[y*code->width+x]&1) cairo_rectangle(cr,cardX+origin+x*module,cardY+origin+y*module,module,module);
    cairo_fill(cr); QRcode_free(code);

    text("Scan to join",1128,66,true,0.94,0.96,1);
    text("Watch, listen and play with the visuals on your phone",1184,29,false,0.61,0.67,0.75);
    std::string shown=url.substr(url.find("//")==std::string::npos ? 0 : url.find("//")+2);
    cairo_select_font_face(cr,"sans-serif",CAIRO_FONT_SLANT_NORMAL,CAIRO_FONT_WEIGHT_NORMAL); cairo_set_font_size(cr,26);
    cairo_text_extents_t extents; cairo_text_extents(cr,shown.c_str(),&extents);
    rounded((W-extents.x_advance)/2-30,1222,extents.x_advance+60,58,29);
    cairo_set_source_rgba(cr,0.22,0.74,0.97,0.12); cairo_fill_preserve(cr); cairo_set_source_rgba(cr,0.22,0.74,0.97,0.7); cairo_set_line_width(cr,2); cairo_stroke(cr);
    text(shown,1260,26,false,0.75,0.9,1);

    bool ok=cairo_surface_write_to_png(surface,path.c_str())==CAIRO_STATUS_SUCCESS;
    cairo_destroy(cr); cairo_surface_destroy(surface);
    return ok;
}
std::vector<Row> guiLayout(int port) {
    std::string p=":"+std::to_string(port);
    std::vector<Row> rows{{"CLAP Visualizer",""},{"",""},{"This computer",""},
        {"Display: http://localhost"+p+"/","http://localhost"+p+"/"},
        {"Remote: http://localhost"+p+"/remote.html","http://localhost"+p+"/remote.html"}};
    ifaddrs *list=nullptr;
    auto tunnel=[&rows] { rows.push_back({"Over the internet (Cloudflare tunnel)",""}); rows.push_back({"",TunnelToggle}); rows.push_back({"",TunnelOpen}); rows.push_back({"",TunnelCopy}); };
    if (getifaddrs(&list)) { tunnel(); return rows; }
    for (ifaddrs *i=list; i && rows.size()<17; i=i->ifa_next) {
        if (!i->ifa_addr || i->ifa_addr->sa_family!=AF_INET || !(i->ifa_flags&IFF_UP) || (i->ifa_flags&IFF_LOOPBACK)) continue;
        std::string name=i->ifa_name;
        // Container bridges are not reachable from a tablet.
        if (name.rfind("docker",0)==0 || name.rfind("br-",0)==0 || name.rfind("veth",0)==0 || name.rfind("virbr",0)==0) continue;
        char ip[INET_ADDRSTRLEN];
        if (!inet_ntop(AF_INET,&reinterpret_cast<sockaddr_in *>(i->ifa_addr)->sin_addr,ip,sizeof(ip))) continue;
        std::string base=std::string("http://")+ip+p;
        rows.push_back({"On the network ("+name+")",""});
        rows.push_back({"Display: "+base+"/",base+"/"});
        rows.push_back({"Tablet remote: "+base+"/remote.html",base+"/remote.html"});
    }
    freeifaddrs(list);
    tunnel();
    return rows;
}
// Finds the quick tunnel address in cloudflared's log output.
std::string tunnelAddress(const std::string &log) {
    const std::string domain=".trycloudflare.com";
    for (size_t end=log.find(domain); end!=std::string::npos; end=log.find(domain,end+1)) {
        size_t start=log.rfind("https://",end);
        if (start==std::string::npos) continue;
        std::string name=log.substr(start+8,end-start-8);
        // api.trycloudflare.com is the service cloudflared itself talks to.
        if (name.empty() || name=="api" || name.find_first_not_of("abcdefghijklmnopqrstuvwxyz0123456789-")!=std::string::npos) continue;
        return "https://"+name+domain;
    }
    return "";
}
struct Client {
    int fd=-1, file=-1;
    bool ws=false, display=false, listen=false, closing=false, dead=false;
    std::string input, output;
    size_t sent=0;
    Clock::time_point progress=Clock::now();
};
struct Plugin {
    clap_plugin_t api{};
    const clap_host_t *host;
    const clap_host_state_t *hostState=nullptr;
    struct Stereo { float l,r; } ring[RingSize]{};
    alignas(64) std::atomic<uint64_t> write{0};
    alignas(64) std::atomic<uint64_t> read{0};
    std::atomic<double> bpm{0}, beat{0}, sampleRate{48000};
    std::atomic<uint32_t> signature{(4u<<16)|4}, sequence{0};
    std::atomic<bool> playing{false}, stop{false}, dirty{false}, guiStop{false};
    std::atomic<int> listenPort{0}; // 0 not started, <0 bind failed, else bound port
    std::thread worker, guiThread;
    std::vector<Row> guiRows;
    uint32_t guiParent=0;
    std::mutex stateMutex;
    std::string state, webRoot;
    uint64_t stateVersion=0;
    // Tunnel: 0 off, 1 starting, 2 running, <0 failed (-1 server not running, -2 cloudflared missing, -3 exited).
    std::atomic<int> tunnelState{0}, tunnelChanges{0};
    std::mutex tunnelMutex;
    std::string tunnelUrl;
    pid_t tunnelPid=0;
    std::thread tunnelReader;
    std::atomic<int> copied{0}; // 1 picture is on the clipboard, -1 copying failed
    explicit Plugin(const clap_host_t *h):host(h) {}
    ~Plugin() { closeGui(); stopTunnel(); stop=true; if (worker.joinable()) worker.join(); }
    void setTunnel(int value) { tunnelState=value; copied=0; ++tunnelChanges; }
    // The public address of the start page, empty while the tunnel is not running.
    std::string tunnelLink() { std::lock_guard<std::mutex> guard(tunnelMutex); return tunnelUrl.empty() ? "" : tunnelUrl+"/start.html"; }
    // Puts the share picture on the clipboard: wl-copy on Wayland, xclip on plain X11. Both keep serving it in the background.
    bool copyCard(const std::string &url) {
        const char *runtime=std::getenv("XDG_RUNTIME_DIR");
        std::string path=std::string(runtime && *runtime ? runtime : "/tmp")+"/clap-visualizer-qr.png";
        if (!shareCard(url,path)) return false;
        const char *wayland[]={"wl-copy","--type","image/png",nullptr}, *x11[]={"xclip","-selection","clipboard","-t","image/png","-i",nullptr};
        for (const char **argv:{wayland,x11}) {
            posix_spawn_file_actions_t actions; posix_spawn_file_actions_init(&actions);
            posix_spawn_file_actions_addopen(&actions,0,path.c_str(),O_RDONLY,0);
            pid_t pid; int status=0;
            int error=posix_spawnp(&pid,argv[0],&actions,nullptr,const_cast<char *const *>(argv),environ);
            posix_spawn_file_actions_destroy(&actions);
            if (!error && waitpid(pid,&status,0)==pid && WIFEXITED(status) && !WEXITSTATUS(status)) return true;
        }
        return false;
    }
    void stopTunnel() {
        { std::lock_guard<std::mutex> guard(tunnelMutex); if (tunnelPid>0) kill(tunnelPid,SIGKILL); } // SIGTERM lets cloudflared wait up to 30 s for open connections; the host must not hang on that
        if (tunnelReader.joinable()) tunnelReader.join();
        setTunnel(0);
    }
    // cloudflared connects out to Cloudflare and forwards the public address to the local server.
    void startTunnel() {
        stopTunnel();
        int port=listenPort.load();
        if (port<=0) { setTunnel(-1); return; }
        int fds[2];
        if (pipe2(fds,O_CLOEXEC)) { setTunnel(-3); return; }
        std::string origin="http://localhost:"+std::to_string(port);
        const char *argv[]={"cloudflared","tunnel","--no-autoupdate","--url",origin.c_str(),nullptr};
        posix_spawn_file_actions_t actions; posix_spawn_file_actions_init(&actions);
        posix_spawn_file_actions_addopen(&actions,0,"/dev/null",O_RDONLY,0);
        posix_spawn_file_actions_adddup2(&actions,fds[1],1); posix_spawn_file_actions_adddup2(&actions,fds[1],2);
        pid_t pid=0;
        int error=posix_spawnp(&pid,"cloudflared",&actions,nullptr,const_cast<char *const *>(argv),environ);
        posix_spawn_file_actions_destroy(&actions); close(fds[1]);
        if (error) { close(fds[0]); setTunnel(error==ENOENT ? -2 : -3); return; }
        { std::lock_guard<std::mutex> guard(tunnelMutex); tunnelPid=pid; tunnelUrl.clear(); }
        setTunnel(1);
        // ponytail: no kill on host crash; cloudflared then dies on its next log write to the closed pipe.
        tunnelReader=std::thread([this,fd=fds[0]] {
            std::string log; char buffer[1024]; ssize_t n;
            while ((n=::read(fd,buffer,sizeof(buffer)))>0) {
                if (tunnelState.load()!=1) continue;
                log.append(buffer,n);
                std::string url=tunnelAddress(log);
                if (!url.empty()) { { std::lock_guard<std::mutex> guard(tunnelMutex); tunnelUrl=url; } setTunnel(2); }
                else if (log.size()>Limit) log.erase(0,log.size()-256);
            }
            close(fd);
            std::lock_guard<std::mutex> guard(tunnelMutex);
            waitpid(tunnelPid,nullptr,0); tunnelPid=0; tunnelUrl.clear();
            setTunnel(-3); // stopTunnel() overwrites this with 0
        });
    }
    void click(const std::string &url) {
        if (url==TunnelToggle) { if (tunnelState.load()>0) stopTunnel(); else startTunnel(); }
        else if (url==TunnelCopy) { std::string link=tunnelLink(); if (!link.empty()) { copied=copyCard(link) ? 1 : -1; ++tunnelChanges; } }
        else if (url==TunnelOpen) { std::string link=tunnelLink(); if (!link.empty()) openUrl(link); }
        else openUrl(url);
    }
    void closeGui() { guiStop=true; if (guiThread.joinable()) guiThread.join(); guiStop=false; }
    int guiHeight() const { return 2*GuiPad+std::max(int(guiRows.size())*GuiLine,2*(QrSize+QrLabel)); }
    void openUrl(const std::string &url) {
        // setsid -f detaches the browser from the host and exits at once, so waitpid cannot block.
        const char *argv[]={"setsid","-f","xdg-open",url.c_str(),nullptr};
        pid_t pid;
        if (posix_spawnp(&pid,"setsid",nullptr,nullptr,const_cast<char *const *>(argv),environ)==0) waitpid(pid,nullptr,0);
        else std::fprintf(stderr,"CLAP Visualizer: cannot open %s\n",url.c_str());
    }
    // Runs on its own thread with its own X connection; xcb reports errors as events instead of exiting the host.
    void gui() {
        xcb_connection_t *c=xcb_connect(nullptr,nullptr);
        if (xcb_connection_has_error(c)) { xcb_disconnect(c); return; }
        const int width=GuiWidth, height=guiHeight();
        xcb_window_t window=xcb_generate_id(c);
        uint32_t mask=XCB_EVENT_MASK_EXPOSURE|XCB_EVENT_MASK_BUTTON_PRESS;
        xcb_create_window(c,XCB_COPY_FROM_PARENT,window,guiParent,0,0,width,height,0,XCB_WINDOW_CLASS_INPUT_OUTPUT,XCB_COPY_FROM_PARENT,XCB_CW_EVENT_MASK,&mask);
        xcb_map_window(c,window);
        xcb_visualtype_t *visual=nullptr;
        if (auto *attributes=xcb_get_window_attributes_reply(c,xcb_get_window_attributes(c,window),nullptr)) {
            for (auto screen=xcb_setup_roots_iterator(xcb_get_setup(c)); screen.rem && !visual; xcb_screen_next(&screen))
                for (auto depth=xcb_screen_allowed_depths_iterator(screen.data); depth.rem && !visual; xcb_depth_next(&depth))
                    for (auto v=xcb_depth_visuals_iterator(depth.data); v.rem; xcb_visualtype_next(&v))
                        if (v.data->visual_id==attributes->visual) { visual=v.data; break; }
            free(attributes);
        }
        cairo_surface_t *surface=visual ? cairo_xcb_surface_create(c,window,visual,width,height) : nullptr;
        cairo_t *cr=surface ? cairo_create(surface) : nullptr;
        auto draw=[&](int port) {
            if (!cr) return;
            cairo_set_source_rgb(cr,0.05,0.07,0.09); cairo_paint(cr);
            // A QR code in the right column, so a phone or tablet does not have to type the address.
            auto qr=[&](const std::string &url,const char *label,int top) {
                QRcode *code=QRcode_encodeString8bit(url.c_str(),0,QR_ECLEVEL_L);
                if (!code) return;
                int scale=std::max(1,QrSize/(code->width+8)), size=scale*(code->width+8), left=GuiWidth-GuiPad-QrSize;
                cairo_set_source_rgb(cr,1,1,1); cairo_rectangle(cr,left,top,size,size); cairo_fill(cr);
                cairo_set_source_rgb(cr,0,0,0);
                for (int y=0;y<code->width;++y) for (int x=0;x<code->width;++x)
                    if (code->data[y*code->width+x]&1) cairo_rectangle(cr,left+(x+4)*scale,top+(y+4)*scale,scale,scale);
                cairo_fill(cr); QRcode_free(code);
                cairo_select_font_face(cr,"sans-serif",CAIRO_FONT_SLANT_NORMAL,CAIRO_FONT_WEIGHT_NORMAL); cairo_set_font_size(cr,12);
                cairo_set_source_rgb(cr,0.55,0.58,0.62); cairo_move_to(cr,left,top+size+16); cairo_show_text(cr,label);
            };
            std::string network, internet=tunnelLink();
            for (const Row &row:guiRows) if (network.empty() && row.text.rfind("Tablet remote",0)==0) network=row.url.substr(0,row.url.rfind('/'))+"/start.html";
            if (port>0 && !network.empty()) qr(network,"Scan: on the network",GuiPad);
            if (!internet.empty()) qr(internet,"Scan: over the internet",GuiPad+QrSize+QrLabel);
            for (size_t i=0;i<guiRows.size();++i) {
                std::string text=guiRows[i].text;
                bool link=!guiRows[i].url.empty(), title=i==0, failed=i==1 && port<0;
                if (guiRows[i].url==TunnelToggle) text=tunnelState.load()>0 ? "Stop internet link" : "Start internet link";
                if (guiRows[i].url==TunnelCopy) {
                    int done=copied.load();
                    link=!internet.empty(); failed=link && done<0; if (failed) link=false;
                    text=!link && !failed ? "" : done>0 ? "Copied – paste the picture into your chat (copy again)"
                        : done<0 ? "Copying failed: install wl-clipboard or xclip" : "Copy QR picture for sharing";
                }
                if (guiRows[i].url==TunnelOpen) {
                    int tunnel=tunnelState.load();
                    link=!internet.empty(); failed=tunnel<0;
                    text=link ? internet : tunnel>0 ? "Starting tunnel …" : tunnel==-1 ? "Start the server first: activate the plugin"
                        : tunnel==-2 ? "cloudflared is not installed" : tunnel==-3 ? "The tunnel stopped unexpectedly"
                        : "Off – nothing is reachable from the internet";
                }
                if (i==1) {
                    int shown=port>0 ? port : port<0 ? -port : configuredPort();
                    text=port>0 ? "Server running on port "+std::to_string(shown)+" – click a link to open the browser"
                       : port<0 ? "Server not started: port "+std::to_string(shown)+" is in use"
                       : "The server starts once the plugin is active";
                }
                cairo_select_font_face(cr,"sans-serif",CAIRO_FONT_SLANT_NORMAL,title ? CAIRO_FONT_WEIGHT_BOLD : CAIRO_FONT_WEIGHT_NORMAL);
                cairo_set_font_size(cr,title ? 17 : link ? 14 : 12);
                if (link) cairo_set_source_rgb(cr,0.22,0.74,0.97);
                else if (title) cairo_set_source_rgb(cr,0.94,0.96,0.99);
                else if (failed) cairo_set_source_rgb(cr,0.97,0.44,0.44);
                else cairo_set_source_rgb(cr,0.55,0.58,0.62);
                cairo_move_to(cr,GuiPad+(link ? 12 : 0),GuiPad+(i+1)*GuiLine-8);
                cairo_show_text(cr,text.c_str());
            }
            cairo_surface_flush(surface); xcb_flush(c);
        };
        xcb_flush(c);
        int drawn=listenPort.load(), changes=tunnelChanges.load(); draw(drawn);
        pollfd fd{xcb_get_file_descriptor(c),POLLIN,0};
        while (!guiStop.load() && !xcb_connection_has_error(c)) {
            poll(&fd,1,200);
            while (xcb_generic_event_t *event=xcb_poll_for_event(c)) {
                uint8_t type=event->response_type&0x7f;
                if (type==XCB_EXPOSE) draw(drawn);
                if (type==XCB_BUTTON_PRESS) {
                    auto *press=reinterpret_cast<xcb_button_press_event_t *>(event);
                    int row=(press->event_y-GuiPad)/GuiLine;
                    if (press->detail==1 && press->event_y>=GuiPad && row<int(guiRows.size()) && !guiRows[row].url.empty() && press->event_x<GuiWidth-QrSize-2*GuiPad) click(guiRows[row].url);
                }
                free(event);
            }
            if (int port=listenPort.load(), now=tunnelChanges.load(); port!=drawn || now!=changes) { drawn=port; changes=now; draw(drawn); }
        }
        if (cr) cairo_destroy(cr);
        // cairo caches a device per connection pointer; finish it, or a later connection at the same address aborts.
        if (surface) { cairo_surface_finish(surface); cairo_device_finish(cairo_surface_get_device(surface)); cairo_surface_destroy(surface); }
        xcb_destroy_window(c,window); xcb_flush(c); xcb_disconnect(c);
    }
    void queue(Client &c, const std::string &bytes, bool audio=false) {
        if (c.dead || c.closing) return;
        if (audio && c.output.size()!=c.sent) return;
        if (c.sent) { c.output.erase(0,c.sent); c.sent=0; }
        if (c.output.size()+bytes.size()>QueueLimit) { c.dead=true; return; }
        if (c.output.empty()) c.progress=Clock::now();
        c.output+=bytes;
    }
    void closeWS(Client &c, uint16_t code) {
        queue(c,frame(8,std::string{char(code>>8),char(code)})); c.closing=true;
    }
    void response(Client &c, const char *status, const std::string &body) {
        queue(c,std::string("HTTP/1.1 ")+status+"\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: "+std::to_string(body.size())+"\r\n\r\n"+body);
        c.closing=true;
    }
    void http(Client &c) {
        size_t end=c.input.find("\r\n\r\n");
        if (end==std::string::npos) { if (c.input.size()>Limit) response(c,"431 Request Header Fields Too Large", "header too large"); return; }
        if (end+4>Limit) { response(c,"431 Request Header Fields Too Large","header too large"); return; }
        std::string request=c.input.substr(0,end); c.input.erase(0,end+4);
        size_t lineEnd=request.find("\r\n");
        std::string line=request.substr(0,lineEnd);
        size_t a=line.find(' '), b=line.find(' ',a==std::string::npos ? a : a+1);
        if (a==std::string::npos || b==std::string::npos ||
            (line.substr(b+1)!="HTTP/1.1" && line.substr(b+1)!="HTTP/1.0")) { response(c,"400 Bad Request","bad request"); return; }
        if (line.substr(0,a)!="GET") { response(c,"405 Method Not Allowed","GET only"); return; }
        std::string path=line.substr(a+1,b-a-1), key, upgrade, connection, version, hostHeader, origin;
        bool keySeen=false, versionSeen=false, hostSeen=false;
        size_t pos=lineEnd==std::string::npos ? request.size() : lineEnd+2;
        while (pos<request.size()) {
            size_t next=request.find("\r\n",pos); if (next==std::string::npos) next=request.size();
            std::string header=request.substr(pos,next-pos); size_t colon=header.find(':');
            if (colon==std::string::npos) { response(c,"400 Bad Request","bad header"); return; }
            std::string name=lower(header.substr(0,colon)), value=trim(header.substr(colon+1));
            if (name=="sec-websocket-key") { if (keySeen) { response(c,"400 Bad Request","duplicate key"); return; } keySeen=true; key=value; }
            if (name=="sec-websocket-version") { if (versionSeen) { response(c,"400 Bad Request","duplicate version"); return; } versionSeen=true; version=value; }
            if (name=="host") { if (hostSeen) { response(c,"400 Bad Request","duplicate host"); return; } hostSeen=true; hostHeader=value; }
            if (name=="origin") origin=value;
            if (name=="upgrade") upgrade+=","+value;
            if (name=="connection") connection+=","+value;
            pos=next+2;
        }
        path=path.substr(0,path.find('?'));
        std::string decoded;
        auto hex=[](char x)->int { if (x>='0'&&x<='9') return x-'0'; if (x>='a'&&x<='f') return x-'a'+10; if (x>='A'&&x<='F') return x-'A'+10; return -1; };
        for (size_t i=0;i<path.size();++i) {
            char ch=path[i];
            if (ch=='%') { if (i+2>=path.size() || hex(path[i+1])<0 || hex(path[i+2])<0) { response(c,"400 Bad Request","bad escape"); return; }
                ch=char(hex(path[i+1])*16+hex(path[i+2])); i+=2; }
            if (uint8_t(ch)<32 || ch=='\\') { response(c,"403 Forbidden","forbidden path"); return; }
            decoded+=ch;
        }
        if (decoded.empty() || decoded[0]!='/' || decoded.find("..")!=std::string::npos) { response(c,"403 Forbidden","forbidden path"); return; }
        if (decoded=="/ws") {
            // Browsers name the page that opens the socket. Only our own pages may, or any website could listen in on localhost.
            if (!origin.empty() && lower(origin.substr(origin.find("://")==std::string::npos ? 0 : origin.find("://")+3))!=lower(hostHeader)) { response(c,"403 Forbidden","foreign origin"); return; }
            constexpr char alphabet[]="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
            bool valid=key.size()==24 && key.substr(22)=="==";
            for (size_t i=0;i<std::min(size_t(22),key.size());++i) if (!std::strchr(alphabet,key[i]) || !key[i]) valid=false;
            if (valid && ((std::strchr(alphabet,key[21])-alphabet)&15)) valid=false;
            if (!valid || hostHeader.empty() || version!="13" || !token(upgrade,"websocket") || !token(connection,"upgrade") || line.substr(b+1)!="HTTP/1.1") { response(c,"400 Bad Request","bad websocket handshake"); return; }
            queue(c,"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: "+acceptKey(key)+"\r\n\r\n");
            c.ws=true;
            std::lock_guard<std::mutex> guard(stateMutex);
            if (!state.empty()) queue(c,frame(1,state));
            return;
        }
        if (decoded=="/") decoded="/index.html";
        char resolved[4096];
        if (webRoot.empty() || !realpath((webRoot+decoded).c_str(),resolved)) { response(c,"404 Not Found","not found"); return; }
        std::string full=resolved;
        if (full.compare(0,webRoot.size()+1,webRoot+"/")!=0) { response(c,"403 Forbidden","forbidden path"); return; }
        c.file=open(full.c_str(),O_RDONLY|O_CLOEXEC|O_NONBLOCK);
        struct stat st{};
        if (c.file<0 || fstat(c.file,&st)!=0 || !S_ISREG(st.st_mode)) {
            if (c.file>=0) close(c.file);
            c.file=-1; response(c,"404 Not Found","not found"); return;
        }
        queue(c,std::string("HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Type: ")+mime(full)+"\r\nContent-Length: "+std::to_string(st.st_size)+"\r\n\r\n");
        c.closing=true;
    }
    void websocket(Client &c, std::vector<Client> &clients, uint64_t &seenVersion) {
        while (!c.closing && !c.dead && c.input.size()>=2) {
            const auto *p=reinterpret_cast<const uint8_t *>(c.input.data());
            uint8_t op=p[0]&15; uint64_t n=p[1]&127; size_t h=2;
            if ((p[0]&0x70) || !(p[0]&0x80) || !(p[1]&0x80) ||
                (op!=1 && op!=2 && op!=8 && op!=9 && op!=10)) { closeWS(c,1002); break; }
            if (n==126) { if (c.input.size()<4) break; n=(uint64_t(p[2])<<8)|p[3]; h=4; if (n<126) { closeWS(c,1002); break; } }
            else if (n==127) { if (c.input.size()<10) break; n=0; for (int i=2;i<10;++i) n=(n<<8)|p[i]; h=10; if (n<=65535 || (p[2]&128)) { closeWS(c,1002); break; } }
            if (n>Limit || (op>=8 && n>125)) { closeWS(c,1009); break; }
            if (c.input.size()<h+4+n) break;
            std::string payload=c.input.substr(h+4,n);
            for (size_t i=0;i<n;++i) payload[i]^=p[h+(i%4)];
            c.input.erase(0,h+4+n);
            if (op==8) {
                if (n==1) { closeWS(c,1002); break; }
                if (n>=2) {
                    uint16_t code=(uint16_t(uint8_t(payload[0]))<<8)|uint8_t(payload[1]);
                    if (!((code>=1000 && code<=1014 && code!=1004 && code!=1005 && code!=1006) || (code>=3000 && code<=4999))) { closeWS(c,1002); break; }
                    if (!utf8(payload.substr(2))) { closeWS(c,1007); break; }
                }
                queue(c,frame(8,payload)); c.closing=true; break;
            }
            if (op==9) { queue(c,frame(10,payload)); continue; }
            if (op==10 || op==2) continue;
            if (!utf8(payload)) { closeWS(c,1007); break; }
            if (payload=="hello display") { c.display=true; continue; }
            if (payload=="hello remote") { c.display=false; continue; }
            if (payload=="hello listen") { c.listen=true; continue; }
            if (payload=="hello mute") { c.listen=false; continue; }
            if (payload.compare(0,15,"{\"type\":\"state\"")==0) {
                { std::lock_guard<std::mutex> guard(stateMutex); state=payload; seenVersion=++stateVersion; }
                dirty=true; if (host->request_callback) host->request_callback(host);
            }
            std::string bytes=frame(1,payload);
            for (Client &other:clients) if (other.fd!=c.fd && other.ws) queue(other,bytes);
        }
    }
    void server() {
        int listener=socket(AF_INET,SOCK_STREAM|SOCK_NONBLOCK|SOCK_CLOEXEC,0);
        if (listener<0) { std::perror("CLAP Visualizer socket"); return; }
        int reuse=1; setsockopt(listener,SOL_SOCKET,SO_REUSEADDR,&reuse,sizeof(reuse));
        int port=configuredPort();
        sockaddr_in address{}; address.sin_family=AF_INET; address.sin_addr.s_addr=htonl(INADDR_ANY); address.sin_port=htons(port);
        if (bind(listener,reinterpret_cast<sockaddr *>(&address),sizeof(address)) || listen(listener,16)) { std::perror("CLAP Visualizer bind/listen (audio continues)"); close(listener); listenPort=-port; return; }
        std::fprintf(stderr,"CLAP Visualizer: listening on 0.0.0.0:%d\n",port);
        listenPort=port;
        std::vector<Client> clients;
        uint64_t seenVersion;
        { std::lock_guard<std::mutex> guard(stateMutex); seenVersion=stateVersion; }
        std::array<Stereo,Samples> recent{}; size_t cursor=0;
        std::string pcm;
        double squaresL=0,squaresR=0,peak=0; uint64_t count=0;
        auto nextAudio=Clock::now(), nextTransport=nextAudio;
        try {
            while (!stop.load()) {
                uint64_t r=read.load(std::memory_order_relaxed), w=write.load(std::memory_order_acquire);
                bool listeners=false;
                for (Client &c:clients) if (c.ws && c.listen) listeners=true;
                if (!listeners) pcm.clear();
                while (r!=w) {
                    Stereo s=ring[r++%RingSize]; recent[cursor++%Samples]=s;
                    double l=std::isfinite(s.l) ? s.l : 0, rr=std::isfinite(s.r) ? s.r : 0;
                    squaresL+=l*l; squaresR+=rr*rr; peak=std::max(peak,std::max(std::abs(l),std::abs(rr))); ++count;
                    if (listeners) for (double v:{l,rr}) { int16_t n=int16_t(std::lround(std::clamp(v,-1.0,1.0)*32767)); pcm+=char(n); pcm+=char(n>>8); }
                }
                read.store(r,std::memory_order_release);
                // Listening clients get every sample as 16-bit stereo, about 40 ms per frame.
                if (pcm.size()>=size_t(sampleRate.load()*0.04)*4) {
                    uint32_t rate=uint32_t(sampleRate.load());
                    std::string bytes=frame(2,std::string{2,2,0,0,char(rate),char(rate>>8),char(rate>>16),char(rate>>24)}+pcm);
                    // A client that falls half a second behind skips frames instead of drifting further.
                    for (Client &c:clients) if (c.ws && c.listen && c.output.size()-c.sent<PcmBacklog) queue(c,bytes);
                    pcm.clear();
                }
                double tempo,position; bool play; uint32_t sig,seq;
                do { seq=sequence.load(std::memory_order_acquire); tempo=bpm.load(); position=beat.load(); play=playing.load(); sig=signature.load(); } while ((seq&1) || seq!=sequence.load(std::memory_order_acquire));
                auto now=Clock::now();
                if (now>=nextAudio) {
                    nextAudio=now+std::chrono::microseconds(16667);
                    std::string payload(16+2*Samples,'\0'); payload[0]=1; payload[1]=play;
                    payload[2]=Samples&255; payload[3]=Samples>>8;
                    float f=tempo; uint32_t fb; uint64_t db; std::memcpy(&fb,&f,4); std::memcpy(&db,&position,8);
                    for (int i=0;i<4;++i) payload[4+i]=char(fb>>(8*i));
                    for (int i=0;i<8;++i) payload[8+i]=char(db>>(8*i));
                    for (size_t i=0;i<Samples;++i) { Stereo s=recent[(cursor+i)%Samples];
                        auto quant=[](float x)->char { if (!std::isfinite(x)) x=0; return char(uint8_t(128+std::clamp(x,-1.f,1.f)*127)); };
                        payload[16+i]=quant(s.l); payload[16+Samples+i]=quant(s.r);
                    }
                    std::string bytes=frame(2,payload);
                    for (Client &c:clients) if (c.ws && c.display) queue(c,bytes,true);
                }
                if (now>=nextTransport) {
                    nextTransport=now+std::chrono::milliseconds(50);
                    double rms=count ? std::sqrt(std::max(squaresL,squaresR)/count) : 0;
                    std::string json="{\"type\":\"transport\",\"bpm\":"+number(tempo)+
                        ",\"playing\":"+(play?"true":"false")+",\"beat\":"+number(position)+
                        ",\"tsNum\":"+std::to_string(sig>>16)+",\"tsDen\":"+std::to_string(sig&65535)+
                        ",\"rms\":"+number(std::min(1.0,rms))+",\"peak\":"+number(std::min(1.0,peak))+
                        ",\"sampleRate\":"+number(sampleRate.load())+"}";
                    for (Client &c:clients) if (c.ws) queue(c,frame(1,json));
                    squaresL=squaresR=peak=0; count=0;
                }
                { std::lock_guard<std::mutex> guard(stateMutex);
                    if (seenVersion!=stateVersion) { seenVersion=stateVersion; if (!state.empty()) for (Client &c:clients) if (c.ws) queue(c,frame(1,state)); }
                }
                std::vector<pollfd> fds{{listener,POLLIN,0}};
                for (Client &c:clients) fds.push_back({c.fd,short((!c.closing?POLLIN:0)|((c.sent<c.output.size() || c.file>=0)?POLLOUT:0)),0});
                int ready=poll(fds.data(),fds.size(),5);
                if (ready<0 && errno!=EINTR) break;
                for (size_t i=0;i<clients.size();++i) {
                    Client &c=clients[i]; short events=fds[i+1].revents;
                    if (events&(POLLERR|POLLNVAL)) c.dead=true;
                    if ((events&POLLIN) && !c.dead) {
                        char buffer[8192];
                        // One bounded read per poll keeps a busy peer from starving other clients.
                        ssize_t n=recv(c.fd,buffer,sizeof(buffer),0);
                        if (n>0) {
                            c.input.append(buffer,n);
                            if (!c.ws) http(c);
                            if (c.ws) websocket(c,clients,seenVersion);
                            if (c.ws && c.input.size()>Limit+14) closeWS(c,1009);
                        } else if (n==0 || (errno!=EAGAIN && errno!=EWOULDBLOCK && errno!=EINTR)) c.dead=true;
                    }
                    if ((events&POLLOUT) && !c.dead) {
                        if (c.sent==c.output.size() && c.file>=0) {
                            char buffer[16384]; ssize_t n=::read(c.file,buffer,sizeof(buffer));
                            if (n>0) { c.output.assign(buffer,n); c.sent=0; }
                            else { close(c.file); c.file=-1; if (n<0) c.dead=true; }
                        }
                        if (c.sent<c.output.size()) {
                            ssize_t n=send(c.fd,c.output.data()+c.sent,c.output.size()-c.sent,MSG_NOSIGNAL);
                            if (n>0) { c.sent+=n; c.progress=Clock::now(); }
                            else if (n<0 && errno!=EAGAIN && errno!=EWOULDBLOCK && errno!=EINTR) c.dead=true;
                        }
                        if (c.sent==c.output.size()) { c.output.clear(); c.sent=0; if (c.closing && c.file<0) c.dead=true; }
                    }
                    if (events&POLLHUP) c.dead=true;
                    if (((!c.ws || c.closing) || !c.output.empty()) && Clock::now()-c.progress>std::chrono::seconds(10)) c.dead=true;
                }
                for (auto it=clients.begin();it!=clients.end();) {
                    if (it->dead) { close(it->fd); if (it->file>=0) close(it->file); it=clients.erase(it); } else ++it;
                }
                if (fds[0].revents&POLLIN) {
                    int fd=accept4(listener,nullptr,nullptr,SOCK_NONBLOCK|SOCK_CLOEXEC);
                    if (fd>=0) { if (clients.size()>=32) close(fd); else { clients.emplace_back(); clients.back().fd=fd; } }
                }
            }
        } catch (...) { std::fprintf(stderr,"CLAP Visualizer: server stopped after resource failure; audio continues\n"); }
        for (Client &c:clients) { close(c.fd); if (c.file>=0) close(c.file); }
        close(listener);
    }
};
Plugin &self(const clap_plugin_t *p) { return *static_cast<Plugin *>(p->plugin_data); }
const char *features[]={CLAP_PLUGIN_FEATURE_AUDIO_EFFECT,CLAP_PLUGIN_FEATURE_ANALYZER,CLAP_PLUGIN_FEATURE_STEREO,nullptr};
const clap_plugin_descriptor_t descriptor={CLAP_VERSION,"org.vstvisualizer.visualizer","CLAP Visualizer","CLAP Visualizer","","","","1.2.0","Stereo passthrough with browser visualization",features};
bool init(const clap_plugin_t *p) {
    auto &s=self(p);
    try {
        if (s.host->get_extension) s.hostState=static_cast<const clap_host_state_t *>(s.host->get_extension(s.host,CLAP_EXT_STATE));
        std::string root;
        if (const char *env=std::getenv("VSTVIS_WEB_DIR")) root=env;
        else { Dl_info info{}; if (dladdr(reinterpret_cast<void *>(&init),&info) && info.dli_fname) {
            char resolved[4096]; std::string path=realpath(info.dli_fname,resolved) ? resolved : info.dli_fname;
            root=path.substr(0,path.find_last_of('/'))+"/clapvisualizer.web";
        } }
        char resolved[4096]; if (realpath(root.c_str(),resolved)) s.webRoot=resolved;
        return true;
    } catch (...) { return false; }
}
bool activate(const clap_plugin_t *p,double rate,uint32_t,uint32_t) {
    auto &s=self(p); if (!std::isfinite(rate) || rate<=0) return false; s.sampleRate=rate;
    if (!s.worker.joinable()) try { s.worker=std::thread([&s]{s.server();}); } catch (...) { std::fprintf(stderr,"CLAP Visualizer: cannot start server; audio continues\n"); }
    return true;
}
void transport(Plugin &s,const clap_event_transport_t *t) {
    s.sequence.fetch_add(1,std::memory_order_acq_rel);
    s.bpm=t && (t->flags&CLAP_TRANSPORT_HAS_TEMPO) && std::isfinite(t->tempo) ? t->tempo : 0;
    s.beat=t && (t->flags&CLAP_TRANSPORT_HAS_BEATS_TIMELINE) ? double(t->song_pos_beats)/CLAP_BEATTIME_FACTOR : 0;
    s.playing=t && (t->flags&CLAP_TRANSPORT_IS_PLAYING);
    s.signature=t && (t->flags&CLAP_TRANSPORT_HAS_TIME_SIGNATURE) ? (uint32_t(t->tsig_num)<<16)|t->tsig_denom : (4u<<16)|4;
    s.sequence.fetch_add(1,std::memory_order_release);
}
clap_process_status process(const clap_plugin_t *p,const clap_process_t *data) {
    auto &s=self(p); transport(s,data->transport);
    if (data->in_events) {
        uint32_t n=data->in_events->size(data->in_events);
        for (uint32_t i=0;i<n;++i) { const auto *e=data->in_events->get(data->in_events,i);
            if (e && e->space_id==CLAP_CORE_EVENT_SPACE_ID && e->type==CLAP_EVENT_TRANSPORT && e->size>=sizeof(clap_event_transport_t)) transport(s,reinterpret_cast<const clap_event_transport_t *>(e)); }
    }
    if (!data->audio_outputs_count) return CLAP_PROCESS_CONTINUE;
    auto &out=data->audio_outputs[0]; const auto *in=data->audio_inputs_count ? &data->audio_inputs[0] : nullptr;
    if (!out.data32 && !out.data64) return CLAP_PROCESS_ERROR;
    uint64_t w=s.write.load(std::memory_order_relaxed), r=s.read.load(std::memory_order_acquire);
    size_t room=RingSize-(w-r);
    for (uint32_t i=0;i<data->frames_count;++i) {
        double values[2]={0,0};
        for (uint32_t ch=0;ch<out.channel_count;++ch) {
            uint32_t src=in && in->channel_count ? std::min(ch,in->channel_count-1) : 0;
            if (out.data64) { double v=in && in->channel_count ? (in->data64 ? in->data64[src][i] : in->data32[src][i]) : 0; out.data64[ch][i]=v; if (ch<2) values[ch]=v; }
            else { float v=in && in->channel_count ? (in->data32 ? in->data32[src][i] : float(in->data64[src][i])) : 0; out.data32[ch][i]=v; if (ch<2) values[ch]=v; }
        }
        if (out.channel_count==1) values[1]=values[0];
        if (i<room) s.ring[w++%RingSize]={float(values[0]),float(values[1])};
    }
    out.constant_mask=0;
    s.write.store(w,std::memory_order_release);
    return CLAP_PROCESS_CONTINUE;
}
const clap_plugin_audio_ports_t ports={
    [](const clap_plugin_t *,bool)->uint32_t {return 1;},
    [](const clap_plugin_t *,uint32_t index,bool input,clap_audio_port_info_t *info)->bool {
        if (index || !info) return false;
        *info={}; info->id=0;
        std::strcpy(info->name,input ? "Stereo Input" : "Stereo Output");
        info->flags=CLAP_AUDIO_PORT_IS_MAIN|CLAP_AUDIO_PORT_SUPPORTS_64BITS|CLAP_AUDIO_PORT_REQUIRES_COMMON_SAMPLE_SIZE;
        info->channel_count=2; info->port_type=CLAP_PORT_STEREO; info->in_place_pair=0; return true;
    }
};
const clap_plugin_state_t stateExtension={
    [](const clap_plugin_t *p,const clap_ostream_t *stream)->bool {
        try { std::string state; { std::lock_guard<std::mutex> guard(self(p).stateMutex); state=self(p).state; }
            size_t pos=0; while (pos<state.size()) { int64_t n=stream->write(stream,state.data()+pos,state.size()-pos); if (n<=0 || uint64_t(n)>state.size()-pos) return false; pos+=n; } return true;
        } catch (...) {return false;}
    },
    [](const clap_plugin_t *p,const clap_istream_t *stream)->bool {
        try { std::string state; char buffer[4096];
            while (true) { int64_t n=stream->read(stream,buffer,sizeof(buffer)); if (n<0 || n>int64_t(sizeof(buffer))) return false; if (!n) break;
                if (state.size()+n>Limit) return false;
                state.append(buffer,n); }
            if (!utf8(state)) return false;
            auto &s=self(p); std::lock_guard<std::mutex> guard(s.stateMutex); s.state=std::move(state); ++s.stateVersion; return true;
        } catch (...) {return false;}
    }
};
bool guiApi(const char *api,bool floating) { return !floating && api && !std::strcmp(api,CLAP_WINDOW_API_X11); }
const clap_plugin_gui_t guiExtension={
    [](const clap_plugin_t *,const char *api,bool floating)->bool { return guiApi(api,floating); },
    [](const clap_plugin_t *,const char **api,bool *floating)->bool { *api=CLAP_WINDOW_API_X11; *floating=false; return true; },
    [](const clap_plugin_t *p,const char *api,bool floating)->bool {
        if (!guiApi(api,floating)) return false;
        try { self(p).guiRows=guiLayout(configuredPort()); return true; } catch (...) { return false; }
    },
    [](const clap_plugin_t *p) { self(p).closeGui(); },
    [](const clap_plugin_t *,double)->bool { return false; },
    [](const clap_plugin_t *p,uint32_t *width,uint32_t *height)->bool { *width=GuiWidth; *height=self(p).guiHeight(); return true; },
    [](const clap_plugin_t *)->bool { return false; },
    [](const clap_plugin_t *,clap_gui_resize_hints_t *)->bool { return false; },
    [](const clap_plugin_t *p,uint32_t *width,uint32_t *height)->bool { *width=GuiWidth; *height=self(p).guiHeight(); return true; },
    [](const clap_plugin_t *,uint32_t,uint32_t)->bool { return true; },
    [](const clap_plugin_t *p,const clap_window_t *window)->bool {
        auto &s=self(p); if (!window || !window->x11 || s.guiThread.joinable()) return false;
        s.guiParent=uint32_t(window->x11);
        try { s.guiThread=std::thread([&s]{s.gui();}); return true; } catch (...) { return false; }
    },
    [](const clap_plugin_t *,const clap_window_t *)->bool { return false; },
    [](const clap_plugin_t *,const char *) {},
    [](const clap_plugin_t *)->bool { return true; },
    [](const clap_plugin_t *)->bool { return true; }
};
const void *extension(const clap_plugin_t *,const char *id) {
    if (!std::strcmp(id,CLAP_EXT_GUI)) return &guiExtension;
    if (!std::strcmp(id,CLAP_EXT_AUDIO_PORTS)) return &ports;
    if (!std::strcmp(id,CLAP_EXT_STATE)) return &stateExtension;
    return nullptr;
}
const clap_plugin_t *create(const clap_plugin_factory_t *,const clap_host_t *host,const char *id) {
    if (!host || !clap_version_is_compatible(host->clap_version) || std::strcmp(id,descriptor.id)) return nullptr;
    try { auto *s=new Plugin(host);
        s->api={&descriptor,s,init,[](const clap_plugin_t *p){delete &self(p);},activate,
            [](const clap_plugin_t *){},[](const clap_plugin_t *)->bool{return true;},[](const clap_plugin_t *){},
            [](const clap_plugin_t *p){transport(self(p),nullptr);},process,extension,
            [](const clap_plugin_t *p){auto &s=self(p); if (s.dirty.exchange(false) && s.hostState) s.hostState->mark_dirty(s.host);}};
        return &s->api;
    } catch (...) { return nullptr; }
}
const clap_plugin_factory_t factory={[](const clap_plugin_factory_t *)->uint32_t{return 1;},
    [](const clap_plugin_factory_t *,uint32_t i)->const clap_plugin_descriptor_t *{return i ? nullptr : &descriptor;},create};
} // namespace
extern "C" CLAP_EXPORT const clap_plugin_entry_t clap_entry={CLAP_VERSION,
    [](const char *)->bool{return true;},[](){},
    [](const char *id)->const void *{return std::strcmp(id,CLAP_PLUGIN_FACTORY_ID) ? nullptr : &factory;}};
