import React, { useEffect, useRef, useState } from "react";
import {
  SafeAreaView,
  View,
  Text,
  TextInput,
  Button,
  ScrollView,
  PermissionsAndroid,
  Platform,
} from "react-native";
import io, { Socket } from "socket.io-client";
import {
  RTCPeerConnection,
  RTCIceCandidate,
  RTCSessionDescription,
  mediaDevices,
  MediaStream,
  RTCView,
} from "react-native-webrtc";

const SIGNALING_URL = "http://localhost:3000";
const iceServers = [{ urls: "stun:stun.l.google.com:19302" }];

export default function App() {
  const [roomId, setRoomId] = useState("test-room");
  const [joined, setJoined] = useState(false);
  const [status, setStatus] = useState("idle");
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);

  const socketRef = useRef<Socket | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);

  // Request Android runtime permissions
  const requestPermissions = async () => {
    if (Platform.OS === "android") {
      try {
        const granted = await PermissionsAndroid.requestMultiple([
          PermissionsAndroid.PERMISSIONS.CAMERA,
          PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
        ]);

        const camGranted =
          granted["android.permission.CAMERA"] ===
          PermissionsAndroid.RESULTS.GRANTED;
        const micGranted =
          granted["android.permission.RECORD_AUDIO"] ===
          PermissionsAndroid.RESULTS.GRANTED;

        if (!camGranted || !micGranted) {
          console.log("Permissions denied");
          return false;
        }
        return true;
      } catch (err) {
        console.warn("Permission error", err);
        return false;
      }
    }
    return true;
  };

  //  Get local media stream
  const getLocalStream = async () => {
    const ok = await requestPermissions();
    if (!ok) return;

    const stream = await mediaDevices.getUserMedia({
      audio: true,
      video: {
        facingMode: "back"
      },
    });
    setLocalStream(stream);
  };

  useEffect(() => {
    getLocalStream();
    return () => cleanup();
  }, []);

  const ensurePeer = () => {
    if (!pcRef.current) {
      const pc = new RTCPeerConnection({ iceServers }) as any;

      pc.onicecandidate = (e: any) => {
        if (e.candidate && socketRef.current) {
          socketRef.current.emit("ice-candidate", {
            roomId,
            candidate: e.candidate,
          });
        }
      };

      pc.ontrack = (e: any) => {
        const [stream] = e.streams;
        setRemoteStream(stream);
      };

      if (localStream) {
        localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));
      }

      pcRef.current = pc;
    }
    return pcRef.current!;
  };

  const connectSocket = () => {
    if (!socketRef.current) {
      const s = io(SIGNALING_URL, { transports: ["websocket"] });
      socketRef.current = s;

      s.on("connect", () => setStatus("socket connected"));
      s.on("joined", ({ count }) => setStatus(`joined room (${count})`));
      s.on("peer-joined", () => setStatus("peer joined, waiting for ready"));

      s.on("ready", async () => {
        const pc = ensurePeer();
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socketRef.current?.emit("offer", { roomId, sdp: offer });
        setStatus("sent offer");
      });

      s.on("offer", async ({ sdp }) => {
        const pc = ensurePeer();
        await pc.setRemoteDescription(new RTCSessionDescription(sdp));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socketRef.current?.emit("answer", { roomId, sdp: answer });
        setStatus("answered offer");
      });

      s.on("answer", async ({ sdp }) => {
        const pc = ensurePeer();
        await pc.setRemoteDescription(new RTCSessionDescription(sdp));
        setStatus("connected (answer set)");
      });

      s.on("ice-candidate", async ({ candidate }) => {
        try {
          const pc = ensurePeer();
          await pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (e) {
          console.warn("Failed to add ICE", e);
        }
      });

      s.on("peer-left", () => {
        setStatus("peer left");
        endCall();
      });
    }
  };

  const joinRoom = () => {
    if (!localStream) return;
    connectSocket();
    socketRef.current?.emit("join", roomId);
    setJoined(true);
  };

  const endCall = () => {
    if (socketRef.current && roomId) {
      socketRef.current.emit("leave", roomId);
    }
    if (pcRef.current) {
      pcRef.current.getSenders().forEach((sender) => sender.track?.stop());
      pcRef.current.close();
      pcRef.current = null;
    }
    setRemoteStream(null);
    setJoined(false);
    setStatus("idle");
  };

  const cleanup = () => {
    endCall();
    socketRef.current?.disconnect();
    socketRef.current = null;
    localStream?.getTracks().forEach((t) => t.stop());
    setLocalStream(null);
  };

  // Attach local tracks if peer created after stream ready
  useEffect(() => {
    if (pcRef.current && localStream) {
      localStream
        .getTracks()
        .forEach((t) => pcRef.current!.addTrack(t, localStream));
    }
  }, [localStream]);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: "#111" }}>
      <ScrollView contentContainerStyle={{ padding: 12, gap: 12 }}>
        <Text style={{ color: "#fff", fontSize: 18, fontWeight: "600" }}>
          WebRTC (Expo Android)
        </Text>
        <Text style={{ color: "#aaa" }}>Status: {status}</Text>

        <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
          <TextInput
            value={roomId}
            onChangeText={setRoomId}
            placeholder="room id"
            placeholderTextColor="#777"
            autoCapitalize="none"
            style={{
              flex: 1,
              backgroundColor: "#222",
              color: "#fff",
              padding: 10,
              borderRadius: 8,
            }}
          />
          <Button
            title={joined ? "Leave" : "Join"}
            onPress={joined ? endCall : joinRoom}
          />
        </View>

        <Text style={{ color: "#fff", marginTop: 8 }}>Local</Text>
        <View
          style={{
            width: "100%",
            height: "auto",
            flexDirection: "row",
            backgroundColor: "#333",
            borderRadius: 8,
          }}
        >
          <View
            style={{
              width: "50%",
              height: 220,
              flexDirection: "row",
              backgroundColor: "#333",
              borderRadius: 8,
              overflow: "hidden",
            }}
          >
            {localStream ? (
              <RTCView
                streamURL={localStream.toURL()}
                style={{
                  width: "100%",
                  height: "auto",
                  backgroundColor: "#333",
                  borderRadius: 8,
                }}
                objectFit="cover"
              />
            ) : (
              <View
                style={{
                  width: "50%",
                  height: 220,
                  backgroundColor: "#333",
                  borderRadius: 8,
                }}
              />
            )}
          </View>
          {remoteStream ? (
            <RTCView
              streamURL={remoteStream.toURL()}
              style={{
                width: "50%",
                height: 220,
                backgroundColor: "#333",
                borderRadius: 10,
              }}
              objectFit="cover"
            />
          ) : (
            <View
              style={{
                width: "50%",
                height: 220,
                backgroundColor: "#333",
                borderRadius: 8,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Text style={{ color: "#888" }}>Waiting for peer…</Text>
            </View>
          )}
        </View>
        <View>
          <Text style={{ color: "#888" }}>chat room</Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
