// A Link peer that holds a session at the given tempo: tools/linkpeer 133 [seconds].
// Prints its peer count once a second, so a test can wait for the plugin to join.
#include <ableton/Link.hpp>
#include <cstdio>
#include <cstdlib>
#include <thread>

int main(int argc, char **argv) {
    double bpm = argc > 1 ? std::atof(argv[1]) : 133;
    int seconds = argc > 2 ? std::atoi(argv[2]) : 30;
    ableton::Link link(bpm);
    link.enable(true);
    for (int i = 0; i < seconds; ++i) {
        std::printf("peers %zu tempo %.2f\n", link.numPeers(), link.captureAppSessionState().tempo()); std::fflush(stdout);
        std::this_thread::sleep_for(std::chrono::seconds(1));
    }
}
