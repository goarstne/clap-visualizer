/**
 * Live camera for the image layers: a phone, tablet or laptop sends its camera to the displays
 * over WebRTC. The plugin only relays the negotiation as text (docs/PROTOCOL.md), the video
 * itself travels directly between the browsers.
 *
 *   camera  -> all      {type:'cam', on:true|false}        camera started / stopped
 *   display -> all      {type:'cam', want:<display id>}    a display has a camera slot and no stream
 *   camera  -> display  {type:'cam', to:<display id>, sdp} offer
 *   display -> camera   {type:'cam', from:<display id>, sdp} answer
 */
(function (root) {
  'use strict';

  // ponytail: one public STUN server and no TURN; a guest behind a strict mobile NAT gets no picture.
  const RTC = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
  const CAM = '@cam';

  // Candidates travel inside the description, so one message each way is enough. Without
  // internet the STUN lookup never finishes, hence the timeout.
  const gathered = pc => new Promise(resolve => {
    const check = () => { if (pc.iceGatheringState === 'complete') resolve(); };
    pc.addEventListener('icegatheringstatechange', check); check(); setTimeout(resolve, 1500);
  });

  // Camera side: one connection per display that asks for the picture.
  function sender(stream, send) {
    const peers = new Map();
    send({ type: 'cam', on: true });
    return {
      async message(message) {
        if (typeof message.want === 'string') {
          const id = message.want, old = peers.get(id);
          if (old) old.close();
          const pc = new RTCPeerConnection(RTC); peers.set(id, pc);
          for (const track of stream.getVideoTracks()) pc.addTrack(track, stream);
          await pc.setLocalDescription(await pc.createOffer()); await gathered(pc);
          if (peers.get(id) === pc) send({ type: 'cam', to: id, sdp: pc.localDescription });
        } else if (message.sdp && peers.has(message.from)) {
          await peers.get(message.from).setRemoteDescription(message.sdp);
        }
      },
      stop() {
        for (const pc of peers.values()) pc.close();
        peers.clear();
        for (const track of stream.getTracks()) track.stop();
        send({ type: 'cam', on: false });
      }
    };
  }

  // Display side: onStream gets the camera's MediaStream, or null once it is gone.
  function receiver(send, onStream) {
    const id = Math.random().toString(36).slice(2);
    let pc = null;
    const drop = () => { if (pc) pc.close(); pc = null; onStream(null); };
    return {
      id, drop,
      async message(message) {
        if (message.on === false) { drop(); return; }
        if (message.to !== id || !message.sdp) return;
        if (pc) pc.close();
        const mine = pc = new RTCPeerConnection(RTC);
        mine.ontrack = event => { if (pc === mine) onStream(event.streams[0] || new MediaStream([event.track])); };
        mine.onconnectionstatechange = () => { if (pc === mine && mine.connectionState === 'failed') drop(); };
        await mine.setRemoteDescription(message.sdp);
        await mine.setLocalDescription(await mine.createAnswer()); await gathered(mine);
        if (pc === mine) send({ type: 'cam', from: id, sdp: mine.localDescription });
      }
    };
  }

  root.VJCam = { CAM, sender, receiver, supported: typeof root.RTCPeerConnection === 'function' };
})(window);
