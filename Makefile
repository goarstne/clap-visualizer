CXX ?= g++
CPPFLAGS += -Ithird_party/clap/include
CXXFLAGS ?= -O2 -g
CXXFLAGS += -std=c++17 -Wall -Wextra -Wpedantic -pthread
LDLIBS += -pthread -ldl
CLAP_DIR ?= $(HOME)/.clap
HEADERS := $(shell find third_party/clap/include -name '*.h')

.PHONY: all test install clean
all: build/vstvisualizer.clap tools/fakehost tools/guitest

build/vstvisualizer.clap: plugin/vstvisualizer.cpp $(HEADERS)
	mkdir -p build
	$(CXX) $(CPPFLAGS) $(shell pkg-config --cflags xcb cairo) $(CXXFLAGS) -fPIC -fvisibility=hidden -shared $< -o $@ $(LDFLAGS) $(LDLIBS) $(shell pkg-config --libs xcb cairo)

tools/fakehost: tools/fakehost.cpp $(HEADERS)
	$(CXX) $(CPPFLAGS) $(CXXFLAGS) $< -o $@ $(LDFLAGS) $(LDLIBS)

tools/guitest: tools/guitest.cpp $(HEADERS)
	$(CXX) $(CPPFLAGS) $(CXXFLAGS) $< -o $@ $(LDFLAGS) $(LDLIBS) -lxcb

test: all
	python3 tools/selftest.py
	tools/guitest build/vstvisualizer.clap

install: all
	install -d "$(CLAP_DIR)"
	install -m 755 build/vstvisualizer.clap "$(CLAP_DIR)/vstvisualizer.clap"
	mkdir -p "$(CLAP_DIR)/vstvisualizer.web"
	cp -a web/. "$(CLAP_DIR)/vstvisualizer.web/"

clean:
	rm -rf build tools/fakehost tools/guitest
