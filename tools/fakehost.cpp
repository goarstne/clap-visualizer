#include <vector>
#include <clap/clap.h>
#include <algorithm>
#include <array>
#include <atomic>
#include <cassert>
#include <chrono>
#include <cmath>
#include <csignal>
#include <cstring>
#include <dlfcn.h>
#include <fstream>
#include <iostream>
#include <iterator>
#include <string>
#include <thread>

namespace {
volatile sig_atomic_t interrupted=0;
std::atomic<bool> callback{false}, finished{false};
void signalHandler(int) { interrupted=1; }
struct Stream { std::string data; size_t pos=0; };
clap_istream_t input(Stream &s) {
    return {&s,[](const clap_istream_t *stream,void *buffer,uint64_t size)->int64_t {
        auto &s=*static_cast<Stream *>(stream->ctx);
        size_t n=std::min({size_t(size),s.data.size()-s.pos,size_t(7)});
        std::memcpy(buffer,s.data.data()+s.pos,n); s.pos+=n; return n;
    }};
}
clap_ostream_t output(Stream &s) {
    return {&s,[](const clap_ostream_t *stream,const void *buffer,uint64_t size)->int64_t {
        auto &s=*static_cast<Stream *>(stream->ctx); size_t n=std::min(size_t(size),size_t(5));
        s.data.append(static_cast<const char *>(buffer),n); return n;
    }};
}
}
int main(int argc,char **argv) {
    double duration=argc>1 ? std::stod(argv[1]) : 0;
    const char *path=argc>2 ? argv[2] : "build/clapvisualizer.clap";
    void *library=dlopen(path,RTLD_NOW|RTLD_LOCAL);
    if (!library) { std::cerr<<dlerror()<<'\n'; return 1; }
    const auto *entry=static_cast<const clap_plugin_entry_t *>(dlsym(library,"clap_entry"));
    assert(entry && clap_version_is_compatible(entry->clap_version) && entry->init(path));
    const auto *factory=static_cast<const clap_plugin_factory_t *>(entry->get_factory(CLAP_PLUGIN_FACTORY_ID));
    assert(factory && factory->get_plugin_count(factory)==1);
    clap_host_t host{CLAP_VERSION,nullptr,"fakehost","CLAP Visualizer","","1.0",
        [](const clap_host_t *,const char *)->const void *{return nullptr;},
        [](const clap_host_t *){},[](const clap_host_t *){},[](const clap_host_t *){callback=true;}};
    const clap_plugin_t *plugin=factory->create_plugin(factory,&host,factory->get_plugin_descriptor(factory,0)->id);
    assert(plugin && plugin->init(plugin));
    const auto *ports=static_cast<const clap_plugin_audio_ports_t *>(plugin->get_extension(plugin,CLAP_EXT_AUDIO_PORTS));
    clap_audio_port_info_t info{};
    assert(ports && ports->count(plugin,true)==1 && ports->count(plugin,false)==1);
    assert(ports->get(plugin,0,true,&info) && info.channel_count==2 && info.in_place_pair==0);
    assert(ports->get(plugin,0,false,&info) && info.channel_count==2 && !ports->get(plugin,1,false,&info));
    const auto *state=static_cast<const clap_plugin_state_t *>(plugin->get_extension(plugin,CLAP_EXT_STATE));
    assert(state);
    Stream fixture{"{\"type\":\"state\",\"preset\":\"fakehost self-check\"}"}; auto in=input(fixture);
    assert(state->load(plugin,&in)); Stream saved; auto out=output(saved);
    assert(state->save(plugin,&out) && saved.data==fixture.data);
    Stream tooLarge{std::string(65537,'x')}; in=input(tooLarge); assert(!state->load(plugin,&in));
    saved={}; out=output(saved); assert(state->save(plugin,&out) && saved.data==fixture.data);
    Stream empty; in=input(empty); assert(state->load(plugin,&in));
    const char *statePath=std::getenv("VSTVIS_STATE_FILE");
    if (statePath) {
        std::ifstream file(statePath,std::ios::binary);
        if (file) { Stream restored{std::string(std::istreambuf_iterator<char>(file),{})}; in=input(restored); assert(state->load(plugin,&in)); }
    }
    assert(plugin->activate(plugin,48000,512,512));
    std::signal(SIGINT,signalHandler); std::signal(SIGTERM,signalHandler);
    std::thread audio([&]{
        assert(plugin->start_processing(plugin));
        constexpr int block=512; constexpr double rate=48000, pi=3.14159265358979323846;
        std::array<float,block> left{},right{},ol{},orr{};
        float *ip[]={left.data(),right.data()}, *op[]={ol.data(),orr.data()};
        clap_audio_buffer_t ib{},ob{}; ib.data32=ip; ib.channel_count=2; ob.data32=op; ob.channel_count=2;
        clap_process_t proc{}; proc.audio_inputs=&ib; proc.audio_outputs=&ob; proc.audio_inputs_count=proc.audio_outputs_count=1; proc.frames_count=block;
        // Check double precision and mono fallback before the realtime signal loop.
        std::array<double,block> dl{},dr{},dol{},dor{};
        for (int i=0;i<block;++i) {dl[i]=(i-256)*0.001234567890123; dr[i]=-dl[i];}
        double *dip[]={dl.data(),dr.data()}, *dop[]={dol.data(),dor.data()};
        ib.data32=nullptr; ob.data32=nullptr; ib.data64=dip; ob.data64=dop;
        assert(plugin->process(plugin,&proc)==CLAP_PROCESS_CONTINUE);
        assert(dl==dol && dr==dor);
        ib.data64=nullptr; ob.data64=nullptr; ib.data32=ip; ob.data32=op;
        ib.channel_count=1; left.fill(0.125f);
        assert(plugin->process(plugin,&proc)==CLAP_PROCESS_CONTINUE && ol==left && orr==left);
        ib.channel_count=2;
        clap_event_transport_t transport{}; transport.header.size=sizeof(transport); transport.header.type=CLAP_EVENT_TRANSPORT;
        transport.flags=CLAP_TRANSPORT_HAS_TEMPO|CLAP_TRANSPORT_HAS_BEATS_TIMELINE|CLAP_TRANSPORT_HAS_TIME_SIGNATURE|CLAP_TRANSPORT_IS_PLAYING;
        transport.tempo=120; transport.tsig_num=transport.tsig_denom=4; proc.transport=&transport;
        // A stopped host, as during a DJ set with input monitoring only.
        if (std::getenv("VSTVIS_FAKE_STOPPED")) transport.flags&=~uint32_t(CLAP_TRANSPORT_IS_PLAYING);
        // Optional real programme material instead of the test kick: raw stereo float32 LE at 48 kHz, looped.
        std::vector<float> track;
        if (const char *file=std::getenv("VSTVIS_FAKE_AUDIO")) {
            std::ifstream in(file,std::ios::binary); assert(in && "cannot read demo audio");
            std::string bytes{std::istreambuf_iterator<char>(in),{}};
            assert(!bytes.empty() && bytes.size()%(2*sizeof(float))==0 && "expected stereo float32 audio");
            track.resize(bytes.size()/sizeof(float)/2*2); std::memcpy(track.data(),bytes.data(),track.size()*sizeof(float));
        }
        std::cerr<<"fakehost: audio running\n"<<std::flush;
        const auto start=std::chrono::steady_clock::now(); uint64_t samples=0;
        while (!interrupted && (duration<=0 || samples/rate<duration)) {
            for (int i=0;i<block && !track.empty();++i) { size_t at=(samples+i)%(track.size()/2)*2; left[i]=track[at]; right[i]=track[at+1]; }
            for (int i=0;i<block && track.empty();++i) {
                double time=(samples+i)/rate, quarter=std::fmod(time,0.5);
                double kick=quarter<0.15 ? 0.8*std::exp(-quarter*35)*std::cos(2*pi*(55*quarter+3*(1-std::exp(-quarter*30)))) : 0;
                left[i]=kick+0.035*std::sin(2*pi*220*time);
                right[i]=kick+0.035*std::sin(2*pi*330*time);
            }
            proc.steady_time=samples;
            transport.song_pos_beats=clap_beattime(samples*2.0/rate*CLAP_BEATTIME_FACTOR);
            assert(plugin->process(plugin,&proc)==CLAP_PROCESS_CONTINUE);
            assert(ol==left && orr==right);
            samples+=block;
            std::this_thread::sleep_until(start+std::chrono::nanoseconds(uint64_t(samples*1e9/rate)));
        }
        plugin->stop_processing(plugin); finished=true;
    });
    while (!finished) { if (callback.exchange(false)) plugin->on_main_thread(plugin); std::this_thread::sleep_for(std::chrono::milliseconds(10)); }
    audio.join(); plugin->deactivate(plugin);
    if (statePath) {
        saved={}; out=output(saved); assert(state->save(plugin,&out));
        std::ofstream file(statePath,std::ios::binary|std::ios::trunc); file<<saved.data; file.close(); assert(file);
    }
    plugin->destroy(plugin); entry->deinit(); dlclose(library);
    std::cout<<"fakehost: ports, partial state streams, size limit, float/double/mono passthrough OK\n";
}
