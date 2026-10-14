// Live mode without a DAW: loads the plugin, feeds it the sound card and shows its window.
//   pw-record --target <source> --rate 48000 --channels 2 --format f32 - | clapvisualizer-live [plugin.clap]
// stdin carries stereo float32 at 48 kHz. There is no transport, so with Ableton Link on (it starts
// on here) tempo and bar come from the DJ app. The controller state is kept in
// ~/.config/clapvisualizer/live.json. VSTVIS_NO_WINDOW=1 runs without the window (tests).
#include <clap/clap.h>
#include <algorithm>
#include <atomic>
#include <chrono>
#include <csignal>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <dlfcn.h>
#include <fstream>
#include <iterator>
#include <poll.h>
#include <string>
#include <sys/stat.h>
#include <thread>
#include <unistd.h>
#include <vector>
#include <xcb/xcb.h>

namespace {
volatile sig_atomic_t quit=0;
std::atomic<bool> callback{false}, finished{false};
struct Stream { std::string data; size_t pos=0; };

std::string statePath() {
    const char *config=std::getenv("XDG_CONFIG_HOME"), *home=std::getenv("HOME");
    std::string dir=config && *config ? std::string(config) : std::string(home ? home : ".")+"/.config";
    mkdir(dir.c_str(),0755); dir+="/clapvisualizer"; mkdir(dir.c_str(),0755);
    return dir+"/live.json";
}
void save(const clap_plugin_t *plugin,const clap_plugin_state_t *state,const std::string &path) {
    Stream out;
    clap_ostream_t stream{&out,[](const clap_ostream_t *s,const void *buffer,uint64_t size)->int64_t {
        static_cast<Stream *>(s->ctx)->data.append(static_cast<const char *>(buffer),size); return int64_t(size); }};
    if (!state->save(plugin,&stream) || out.data.empty()) return;
    // Write and rename, so a crash never leaves half a file.
    std::ofstream file(path+".tmp",std::ios::binary|std::ios::trunc); file<<out.data; file.close();
    if (file) std::rename((path+".tmp").c_str(),path.c_str());
}
xcb_atom_t atom(xcb_connection_t *c,const char *name) {
    xcb_intern_atom_reply_t *reply=xcb_intern_atom_reply(c,xcb_intern_atom(c,0,std::strlen(name),name),nullptr);
    xcb_atom_t value=reply ? reply->atom : XCB_NONE; free(reply); return value;
}
}

int main(int argc,char **argv) {
    const char *home=std::getenv("HOME");
    std::string path=argc>1 ? argv[1] : std::string(home ? home : ".")+"/.clap/clapvisualizer.clap";
    void *library=dlopen(path.c_str(),RTLD_NOW|RTLD_LOCAL);
    if (!library) { std::fprintf(stderr,"clapvisualizer-live: %s\n",dlerror()); return 1; }
    const auto *entry=static_cast<const clap_plugin_entry_t *>(dlsym(library,"clap_entry"));
    if (!entry || !entry->init(path.c_str())) { std::fprintf(stderr,"clapvisualizer-live: %s is no CLAP plugin\n",path.c_str()); return 1; }
    const auto *factory=static_cast<const clap_plugin_factory_t *>(entry->get_factory(CLAP_PLUGIN_FACTORY_ID));
    clap_host_t host{CLAP_VERSION,nullptr,"clapvisualizer-live","CLAP Visualizer","","1.0",
        [](const clap_host_t *,const char *)->const void *{return nullptr;},
        [](const clap_host_t *){},[](const clap_host_t *){},[](const clap_host_t *){callback=true;}};
    const clap_plugin_t *plugin=factory->create_plugin(factory,&host,factory->get_plugin_descriptor(factory,0)->id);
    if (!plugin || !plugin->init(plugin)) { std::fprintf(stderr,"clapvisualizer-live: plugin does not start\n"); return 1; }
    const auto *state=static_cast<const clap_plugin_state_t *>(plugin->get_extension(plugin,CLAP_EXT_STATE));
    const auto *gui=static_cast<const clap_plugin_gui_t *>(plugin->get_extension(plugin,CLAP_EXT_GUI));

    // The plugin switches Link on when it loads a state in live mode; a first start gets a bare one.
    setenv("VSTVIS_LINK","1",1);
    const std::string stateFile=statePath();
    Stream stored;
    { std::ifstream file(stateFile,std::ios::binary); if (file) stored.data.assign(std::istreambuf_iterator<char>(file),{}); }
    if (stored.data.empty()) stored.data="{\"type\":\"state\",\"v\":2}";
    // The start window chooses auto mode for each run (VSTVIS_AUTO=1); otherwise the run starts manual.
    {
        bool on=std::getenv("VSTVIS_AUTO"); std::string &s=stored.data, value=on ? "\"auto\":true" : "\"auto\":false";
        size_t at=s.find("\"auto\":"), length=at==std::string::npos ? 0 : !s.compare(at,11,"\"auto\":true") ? 11 : !s.compare(at,12,"\"auto\":false") ? 12 : 0;
        if (length) s.replace(at,length,value);
        else if (on && at==std::string::npos && s.size()>1 && s[0]=='{') s.insert(1,value+",");
    }
    clap_istream_t in{&stored,[](const clap_istream_t *s,void *buffer,uint64_t size)->int64_t {
        auto &st=*static_cast<Stream *>(s->ctx); size_t n=std::min(size_t(size),st.data.size()-st.pos);
        std::memcpy(buffer,st.data.data()+st.pos,n); st.pos+=n; return int64_t(n); }};
    if (!state->load(plugin,&in)) std::fprintf(stderr,"clapvisualizer-live: ignoring unreadable %s\n",stateFile.c_str());

    constexpr int block=512;
    if (!plugin->activate(plugin,48000,block,block)) { std::fprintf(stderr,"clapvisualizer-live: plugin does not activate\n"); return 1; }
    std::signal(SIGINT,[](int){quit=1;}); std::signal(SIGTERM,[](int){quit=1;}); std::signal(SIGPIPE,SIG_IGN);

    std::thread audio([&]{
        plugin->start_processing(plugin);
        std::vector<float> frames(block*2), left(block), right(block), outL(block), outR(block);
        float *ip[]={left.data(),right.data()}, *op[]={outL.data(),outR.data()};
        clap_audio_buffer_t ib{},ob{}; ib.data32=ip; ib.channel_count=2; ob.data32=op; ob.channel_count=2;
        clap_process_t proc{}; proc.audio_inputs=&ib; proc.audio_outputs=&ob; proc.audio_inputs_count=proc.audio_outputs_count=1; proc.frames_count=block;
        size_t filled=0; uint64_t samples=0;
        auto *bytes=reinterpret_cast<char *>(frames.data());
        while (!quit) {
            pollfd fd{0,POLLIN,0};
            if (poll(&fd,1,200)<=0) continue;
            ssize_t n=read(0,bytes+filled,frames.size()*sizeof(float)-filled);
            if (n<=0) { std::fprintf(stderr,"clapvisualizer-live: the audio input ended\n"); break; }
            filled+=size_t(n);
            if (filled<frames.size()*sizeof(float)) continue;
            for (int i=0;i<block;++i) { left[i]=frames[2*i]; right[i]=frames[2*i+1]; }
            proc.steady_time=int64_t(samples); samples+=block; filled=0;
            plugin->process(plugin,&proc);
        }
        plugin->stop_processing(plugin); finished=true;
    });

    xcb_connection_t *c=nullptr; xcb_atom_t closeAtom=XCB_NONE;
    if (!std::getenv("VSTVIS_NO_WINDOW") && gui && gui->create(plugin,CLAP_WINDOW_API_X11,false)) {
        c=xcb_connect(nullptr,nullptr);
        if (xcb_connection_has_error(c)) { xcb_disconnect(c); c=nullptr; }
    }
    if (c) {
        uint32_t width=720, height=500; gui->get_size(plugin,&width,&height);
        xcb_screen_t *screen=xcb_setup_roots_iterator(xcb_get_setup(c)).data;
        xcb_window_t window=xcb_generate_id(c);
        uint32_t background=0x0d1217; // the plugin's own background colour
        xcb_create_window(c,XCB_COPY_FROM_PARENT,window,screen->root,int16_t(std::max(0,(screen->width_in_pixels-int(width))/2)),int16_t(std::max(0,(screen->height_in_pixels-int(height))/2)),width,height,0,XCB_WINDOW_CLASS_INPUT_OUTPUT,screen->root_visual,XCB_CW_BACK_PIXEL,&background);
        // Same minimum and maximum size (WM_NORMAL_HINTS), so tiling window managers let it float.
        uint32_t hints[18]={4|16|32,0,0,0,0,width,height,width,height}; // program position, min and max size
        xcb_change_property(c,XCB_PROP_MODE_REPLACE,window,XCB_ATOM_WM_NORMAL_HINTS,XCB_ATOM_WM_SIZE_HINTS,32,18,hints);
        const char title[]="CLAP Visualizer – Live";
        xcb_change_property(c,XCB_PROP_MODE_REPLACE,window,XCB_ATOM_WM_NAME,XCB_ATOM_STRING,8,sizeof(title)-1,title);
        xcb_change_property(c,XCB_PROP_MODE_REPLACE,window,atom(c,"_NET_WM_NAME"),atom(c,"UTF8_STRING"),8,sizeof(title)-1,title);
        xcb_change_property(c,XCB_PROP_MODE_REPLACE,window,XCB_ATOM_WM_CLASS,XCB_ATOM_STRING,8,30,"clapvisualizer\0clapvisualizer");
        closeAtom=atom(c,"WM_DELETE_WINDOW");
        xcb_change_property(c,XCB_PROP_MODE_REPLACE,window,atom(c,"WM_PROTOCOLS"),XCB_ATOM_ATOM,32,1,&closeAtom);
        xcb_map_window(c,window); xcb_flush(c);
        clap_window_t parent{CLAP_WINDOW_API_X11,{}}; parent.x11=window;
        gui->set_parent(plugin,&parent); gui->show(plugin);
    }

    auto lastSave=std::chrono::steady_clock::now(); bool unsaved=false;
    while (!finished && !quit) {
        if (callback.exchange(false)) { plugin->on_main_thread(plugin); unsaved=true; }
        if (unsaved && std::chrono::steady_clock::now()-lastSave>std::chrono::seconds(1)) { save(plugin,state,stateFile); unsaved=false; lastSave=std::chrono::steady_clock::now(); }
        if (c) while (xcb_generic_event_t *event=xcb_poll_for_event(c)) {
            if ((event->response_type&0x7f)==XCB_CLIENT_MESSAGE && reinterpret_cast<xcb_client_message_event_t *>(event)->data.data32[0]==closeAtom) quit=1;
            free(event);
        }
        if (c && xcb_connection_has_error(c)) quit=1;
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }
    quit=1; audio.join();
    if (c) { gui->destroy(plugin); xcb_disconnect(c); }
    plugin->deactivate(plugin);
    save(plugin,state,stateFile);
    plugin->destroy(plugin); entry->deinit(); dlclose(library);
}
