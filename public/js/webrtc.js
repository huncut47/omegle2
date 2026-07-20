/**
 * webrtc.js — RTCPeerConnection management, ICE handling, and stream control.
 *
 * Responsibilities:
 *   • Create and configure the RTCPeerConnection.
 *   • Attach local media tracks to the peer connection.
 *   • Handle the Offer → Answer → ICE Trickle signaling sequence.
 *   • Buffer ICE candidates that arrive before the remote description is set.
 *   • Expose connection state changes via a callback hook.
 *   • Tear down the connection cleanly on leave/disconnect.
 *
 * Exports (as globals):
 *   window.WebRTC.createPeer(localStream, socket, onStateChange)
 *   window.WebRTC.handleOffer(offer, socket)
 *   window.WebRTC.handleAnswer(answer)
 *   window.WebRTC.handleCandidate(candidate)
 *   window.WebRTC.closePeer()
 *   window.WebRTC.isOpen()
 */

window.WebRTC = (() => {
  // ── ICE / STUN config ────────────────────────────────────
  // Drop a TURN server entry into iceServers here when ready for production.
  const ICE_CONFIG = {
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  };

  // ── Private state ────────────────────────────────────────
  let _pc = null;                 // RTCPeerConnection instance
  let _pendingCandidates = [];    // ICE candidates buffered before remoteDescription is set
  let _onStateChange = null;      // Callback: (stateString) => void

  // ── Internal helpers ─────────────────────────────────────

  /**
   * Add any ICE candidates that arrived before setRemoteDescription.
   */
  async function _flushCandidates() {
    for (const candidate of _pendingCandidates) {
      try {
        await _pc.addIceCandidate(candidate);
      } catch (err) {
        console.warn('[WebRTC] Failed to add buffered ICE candidate:', err);
      }
    }
    _pendingCandidates = [];
  }

  // ── Public API ───────────────────────────────────────────

  /**
   * Create a new RTCPeerConnection, attach local tracks, and wire up events.
   * If the `initiator` flag is true (set by the server's "start" event), this
   * peer creates the offer and begins the handshake.
   *
   * @param {MediaStream}  localStream     - Camera/mic stream from getUserMedia
   * @param {object}       socket          - Socket.IO client instance
   * @param {boolean}      initiator       - True if this peer should send the offer
   * @param {function}     onStateChange   - Called with connection state strings
   */
  async function createPeer(localStream, socket, initiator, onStateChange) {
    // Clean up any stale connection first
    closePeer();

    _onStateChange = onStateChange;
    _pc = new RTCPeerConnection(ICE_CONFIG);

    // Attach local tracks so the remote peer can receive our stream
    localStream.getTracks().forEach(track => _pc.addTrack(track, localStream));

    // Route the remote stream to the <video id="remote"> element
    _pc.ontrack = event => {
      const remoteVideo = document.getElementById('remote');
      if (remoteVideo) {
        remoteVideo.srcObject = event.streams[0];
        remoteVideo.onloadedmetadata = () => {
          if (remoteVideo.videoWidth && remoteVideo.videoHeight) {
            const ratio = remoteVideo.videoWidth / remoteVideo.videoHeight;
            const card = document.getElementById('remote-wrap');
            if (card) card.style.aspectRatio = ratio.toString();
          }
        };
      }
    };

    // Trickle ICE: emit each candidate as it is discovered
    _pc.onicecandidate = event => {
      if (event.candidate) socket.emit('candidate', event.candidate);
    };

    // Propagate connection state changes to the UI via the callback
    _pc.onconnectionstatechange = () => {
      if (_onStateChange) _onStateChange(_pc.connectionState);
    };

    // If we are the initiator (2nd peer to join), send the first offer
    if (initiator) {
      try {
        const offer = await _pc.createOffer();
        await _pc.setLocalDescription(offer);
        socket.emit('offer', _pc.localDescription);
      } catch (err) {
        console.error('[WebRTC] Failed to create/send offer:', err);
      }
    }
  }

  /**
   * Handle an incoming SDP offer from the remote peer (non-initiator path).
   * Sets the remote description, creates an answer, and sends it back.
   *
   * @param {RTCSessionDescriptionInit} offer
   * @param {object}                    socket
   */
  async function handleOffer(offer, socket) {
    if (!_pc) { console.warn('[WebRTC] handleOffer called with no active peer'); return; }
    try {
      await _pc.setRemoteDescription(offer);
      await _flushCandidates();
      const answer = await _pc.createAnswer();
      await _pc.setLocalDescription(answer);
      socket.emit('answer', _pc.localDescription);
    } catch (err) {
      console.error('[WebRTC] Failed to handle offer:', err);
    }
  }

  /**
   * Handle an incoming SDP answer from the remote peer (initiator path).
   *
   * @param {RTCSessionDescriptionInit} answer
   */
  async function handleAnswer(answer) {
    if (!_pc) { console.warn('[WebRTC] handleAnswer called with no active peer'); return; }
    try {
      await _pc.setRemoteDescription(answer);
      await _flushCandidates();
    } catch (err) {
      console.error('[WebRTC] Failed to handle answer:', err);
    }
  }

  /**
   * Handle an incoming ICE candidate from the remote peer.
   * Buffers it if the remote description has not been set yet.
   *
   * @param {RTCIceCandidateInit} candidate
   */
  async function handleCandidate(candidate) {
    if (_pc && _pc.remoteDescription) {
      try {
        await _pc.addIceCandidate(candidate);
      } catch (err) {
        console.warn('[WebRTC] Failed to add ICE candidate:', err);
      }
    } else {
      // Remote description not yet applied — queue for later
      _pendingCandidates.push(candidate);
    }
  }

  /**
   * Close the peer connection and clear all state.
   * Safe to call even if no connection is open.
   */
  function closePeer() {
    if (_pc) {
      _pc.close();
      _pc = null;
    }
    _pendingCandidates = [];
    _onStateChange = null;

    // Clear the remote video element
    const remoteVideo = document.getElementById('remote');
    if (remoteVideo) remoteVideo.srcObject = null;
  }

  /**
   * Returns true if an active RTCPeerConnection exists.
   * @returns {boolean}
   */
  function isOpen() {
    return _pc !== null;
  }

  return { createPeer, handleOffer, handleAnswer, handleCandidate, closePeer, isOpen };
})();
