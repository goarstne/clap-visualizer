CXX ?= g++
CPPFLAGS += -Ithird_party/clap/include
CXXFLAGS ?= -O2 -g
CXXFLAGS += -std=c++17 -Wall -Wextra -Wpedantic -pthread
LDLIBS += -pthread -ldl
CLAP_DIR ?= $(HOME)/.clap
HEADERS := $(shell find third_party/clap/include -name '*.h')
# Folder with the images for the five image buttons (jpg, jpeg, png, webp).
PICTURES ?= Pictues

.PHONY: all test install clean pictures depth
all: build/clapvisualizer.clap tools/fakehost tools/guitest

build/clapvisualizer.clap: plugin/clapvisualizer.cpp $(HEADERS)
	mkdir -p build
	$(CXX) $(CPPFLAGS) $(shell pkg-config --cflags xcb cairo libqrencode) $(CXXFLAGS) -fPIC -fvisibility=hidden -shared $< -o $@ $(LDFLAGS) $(LDLIBS) $(shell pkg-config --libs xcb cairo libqrencode)

tools/fakehost: tools/fakehost.cpp $(HEADERS)
	$(CXX) $(CPPFLAGS) $(CXXFLAGS) $< -o $@ $(LDFLAGS) $(LDLIBS)

tools/guitest: tools/guitest.cpp $(HEADERS)
	$(CXX) $(CPPFLAGS) $(CXXFLAGS) $< -o $@ $(LDFLAGS) $(LDLIBS) -lxcb

test: all
	python3 tools/selftest.py
	node tools/webtest.js
	tools/guitest build/clapvisualizer.clap

# Copies the images into the web directory and writes the list the pages load.
pictures:
	rm -rf web/pictures && mkdir -p web/pictures
	if [ -d "$(PICTURES)" ]; then find "$(PICTURES)" -maxdepth 1 -type f \( -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.png' -o -iname '*.webp' \) -exec cp {} web/pictures/ \; ; fi
	python3 -c 'import json, os; names = sorted(os.listdir("web/pictures")); open("web/pictures/index.json", "w").write(json.dumps(names))'

# Fetches the depth model for the camera layer (web/depth.js): onnxruntime-web (MIT, 14 MB) and
# Depth Anything V2 Small (Apache-2.0, 27 MB). Run it once before `make install`.
ORT := https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist
depth:
	mkdir -p web/vendor/depth
	cd web/vendor/depth && curl -fL --remote-name-all $(ORT)/ort.wasm.min.js $(ORT)/ort-wasm-simd-threaded.mjs $(ORT)/ort-wasm-simd-threaded.wasm \
		https://huggingface.co/onnx-community/depth-anything-v2-small/resolve/main/onnx/model_quantized.onnx

install: all pictures
	install -d "$(CLAP_DIR)"
	install -m 755 build/clapvisualizer.clap "$(CLAP_DIR)/clapvisualizer.clap"
	mkdir -p "$(CLAP_DIR)/clapvisualizer.web"
	cp -a web/. "$(CLAP_DIR)/clapvisualizer.web/"

clean:
	rm -rf build tools/fakehost tools/guitest
