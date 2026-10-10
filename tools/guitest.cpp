// Opens the plugin window inside a test parent, checks that it draws and that a
// click on the first link runs xdg-open with the expected URL (stubbed via PATH).
#include <clap/clap.h>
#include <cassert>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <csignal>
#include <cstring>
#include <dlfcn.h>
#include <fstream>
#include <string>
#include <sys/stat.h>
#include <thread>
#include <unistd.h>
#include <xcb/xcb.h>

int main(int argc,char **argv) {
    const char *path=argc>1 ? argv[1] : "build/clapvisualizer.clap";
    char dir[]="/tmp/vstvis-guitest-XXXXXX"; assert(mkdtemp(dir));
    std::string stub=std::string(dir)+"/xdg-open", result=std::string(dir)+"/opened";
    { std::ofstream f(stub); f<<"#!/bin/sh\nprintf '%s' \"$1\" > '"<<result<<"'\n"; }
    chmod(stub.c_str(),0755);
    // Stands in for cloudflared: logs an address like the real one, then stays alive until stopped.
    std::string tunnel=std::string(dir)+"/cloudflared", pidFile=std::string(dir)+"/pid";
    { std::ofstream f(tunnel); f<<"#!/bin/sh\necho $$ > '"<<pidFile<<"'\necho 'INF |  https://live-visuals-demo.trycloudflare.com  |' >&2\nexec sleep 30\n"; }
    chmod(tunnel.c_str(),0755);
    // Stands in for the clipboard tool: keeps what it is given.
    std::string clip=std::string(dir)+"/wl-copy", picture=std::string(dir)+"/clip.png";
    { std::ofstream f(clip); f<<"#!/bin/sh\ncat > '"<<picture<<"'\n"; }
    chmod(clip.c_str(),0755);
    setenv("PATH",(std::string(dir)+":"+getenv("PATH")).c_str(),1);
    setenv("VSTVIS_PORT","18765",1);

    xcb_connection_t *c=xcb_connect(nullptr,nullptr);
    if (xcb_connection_has_error(c)) { std::puts("GUI: no X display, skipped"); return 0; }
    xcb_screen_t *screen=xcb_setup_roots_iterator(xcb_get_setup(c)).data;
    xcb_window_t parent=xcb_generate_id(c);
    xcb_create_window(c,XCB_COPY_FROM_PARENT,parent,screen->root,0,0,800,600,0,XCB_WINDOW_CLASS_INPUT_OUTPUT,screen->root_visual,0,nullptr);
    xcb_map_window(c,parent); xcb_flush(c);

    void *library=dlopen(path,RTLD_NOW|RTLD_LOCAL); assert(library);
    const auto *entry=static_cast<const clap_plugin_entry_t *>(dlsym(library,"clap_entry"));
    assert(entry && entry->init(path));
    const auto *factory=static_cast<const clap_plugin_factory_t *>(entry->get_factory(CLAP_PLUGIN_FACTORY_ID));
    clap_host_t host{CLAP_VERSION,nullptr,"guitest","","","1.0",[](const clap_host_t *,const char *)->const void *{return nullptr;},
        [](const clap_host_t *){},[](const clap_host_t *){},[](const clap_host_t *){}};
    const clap_plugin_t *plugin=factory->create_plugin(factory,&host,factory->get_plugin_descriptor(factory,0)->id);
    assert(plugin && plugin->init(plugin));
    const auto *gui=static_cast<const clap_plugin_gui_t *>(plugin->get_extension(plugin,CLAP_EXT_GUI));
    assert(gui && gui->is_api_supported(plugin,CLAP_WINDOW_API_X11,false) && !gui->is_api_supported(plugin,CLAP_WINDOW_API_X11,true));
    assert(gui->create(plugin,CLAP_WINDOW_API_X11,false));
    uint32_t width=0,height=0; assert(gui->get_size(plugin,&width,&height) && width>=300 && height>=120);
    clap_window_t window{CLAP_WINDOW_API_X11,{}}; window.x11=parent;
    assert(gui->set_parent(plugin,&window) && gui->show(plugin));
    std::this_thread::sleep_for(std::chrono::milliseconds(700));

    auto *tree=xcb_query_tree_reply(c,xcb_query_tree(c,parent),nullptr);
    assert(tree && xcb_query_tree_children_length(tree)==1);
    xcb_window_t child=xcb_query_tree_children(tree)[0]; free(tree);
    // Pixels can only be read while the window is on screen; on another workspace the drawing check is skipped.
    if (auto *image=xcb_get_image_reply(c,xcb_get_image(c,XCB_IMAGE_FORMAT_Z_PIXMAP,child,0,0,width,height,~0u),nullptr)) {
        const uint8_t *pixels=xcb_get_image_data(image); int n=xcb_get_image_data_length(image)/4, light=0;
        for (int i=0;i<n;i++) if (pixels[i*4]+pixels[i*4+1]+pixels[i*4+2]>300) light++;
        free(image);
        std::printf("GUI: window %ux%u, %d text pixels\n",width,height,light);
        assert(light>500);
    } else std::printf("GUI: window %ux%u is not on screen, drawing not checked\n",width,height);

    // Row 3 is the first link ("Display" on this machine): 16 px padding, 26 px per row.
    xcb_button_press_event_t press{}; press.response_type=XCB_BUTTON_PRESS; press.detail=1; press.event=child; press.root=screen->root;
    press.event_x=60; press.event_y=16+3*26+13; press.same_screen=1;
    xcb_send_event(c,0,child,XCB_EVENT_MASK_BUTTON_PRESS,reinterpret_cast<const char *>(&press)); xcb_flush(c);
    std::string opened;
    for (int i=0;i<30 && opened.empty();i++) { std::this_thread::sleep_for(std::chrono::milliseconds(100)); std::ifstream f(result); std::getline(f,opened); }
    std::printf("GUI: click opened \"%s\"\n",opened.c_str());
    assert(opened=="http://localhost:18765/");

    // The last two rows switch the tunnel and open its address; it needs the running server.
    auto clickRow=[&](int row) { press.event_y=16+row*26+13; xcb_send_event(c,0,child,XCB_EVENT_MASK_BUTTON_PRESS,reinterpret_cast<const char *>(&press)); xcb_flush(c); };
    assert(plugin->activate(plugin,48000,1,1024));
    std::this_thread::sleep_for(std::chrono::milliseconds(300));
    // The window may be taller than its rows, so search for the switch from the bottom.
    int rows=height/26;
    for (;rows>6 && access(pidFile.c_str(),F_OK);) { clickRow(--rows-1); std::this_thread::sleep_for(std::chrono::milliseconds(400)); }
    assert(!access(pidFile.c_str(),F_OK)); ++rows;
    unlink(result.c_str()); opened.clear(); clickRow(rows-1);
    for (int i=0;i<30 && opened.empty();i++) { std::this_thread::sleep_for(std::chrono::milliseconds(100)); std::ifstream f(result); std::getline(f,opened); }
    std::printf("GUI: tunnel link opened \"%s\"\n",opened.c_str());
    assert(opened=="https://live-visuals-demo.trycloudflare.com/start.html");
    // The row below copies the share picture: a PNG of 1080×1350 must reach the clipboard tool.
    clickRow(rows);
    std::this_thread::sleep_for(std::chrono::milliseconds(1200));
    { std::ifstream f(picture,std::ios::binary); unsigned char head[24]{}; f.read(reinterpret_cast<char *>(head),24);
      assert(!memcmp(head,"\x89PNG\r\n\x1a\n",8) && ((head[18]<<8)|head[19])==1080 && ((head[22]<<8)|head[23])==1350); }
    std::puts("GUI: share picture copied as 1080x1350 PNG");
    int tunnelPid=0; { std::ifstream f(pidFile); f>>tunnelPid; } assert(tunnelPid>0 && !kill(tunnelPid,0));
    clickRow(rows-2);
    std::this_thread::sleep_for(std::chrono::milliseconds(500));
    assert(kill(tunnelPid,0)); // stopped and reaped

    // Reopening must work: a stale cairo device for the closed connection used to abort the host.
    gui->hide(plugin); gui->destroy(plugin);
    assert(gui->create(plugin,CLAP_WINDOW_API_X11,false) && gui->set_parent(plugin,&window) && gui->show(plugin));
    std::this_thread::sleep_for(std::chrono::milliseconds(300));
    gui->hide(plugin); gui->destroy(plugin); plugin->destroy(plugin); entry->deinit();
    xcb_destroy_window(c,parent); xcb_disconnect(c);
    unlink(stub.c_str()); unlink(result.c_str()); unlink(tunnel.c_str()); unlink(pidFile.c_str()); unlink(clip.c_str()); unlink(picture.c_str()); rmdir(dir);
    std::puts("GUI: links drawn, click opens browser OK");
}
