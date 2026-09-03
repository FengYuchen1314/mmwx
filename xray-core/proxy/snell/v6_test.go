package snell

import (
	"bytes"
	"crypto/rand"
	"io"
	"testing"

	"github.com/xtls/xray-core/common/net"
	"github.com/xtls/xray-core/common/protocol"
)

func TestV6ProfileDeterministic(t *testing.T) {
	psk := []byte("v6-shared-psk-123456")
	p1 := NewProfile(psk)
	p2 := NewProfile(psk)
	if p1.saltBlockLen != p2.saltBlockLen || p1.generator != p2.generator ||
		p1.chunkInitial != p2.chunkInitial || p1.mixMode != p2.mixMode ||
		p1.namespaces.salt != p2.namespaces.salt {
		t.Fatal("NewProfile not deterministic for same PSK")
	}
	p3 := NewProfile([]byte("different-psk-9876543"))
	if p1.namespaces.salt == p3.namespaces.salt && p1.saltBlockLen == p3.saltBlockLen && p1.generator == p3.generator {
		t.Fatal("different PSK produced identical profile params")
	}
}

// v6RoundTrip 用同 psk/profile 建 writer/reader,写多段 payload + zero chunk,读回校验。
func v6RoundTrip(t *testing.T, mode Mode) {
	t.Helper()
	psk := []byte("v6-shared-psk-123456")
	var profile *Profile
	if mode == ModeDefault {
		profile = NewProfile(psk)
	}
	var conn bytes.Buffer

	big := make([]byte, 40000)
	rand.Read(big)
	payloads := [][]byte{
		[]byte("hello snell v6"),
		bytes.Repeat([]byte("B"), 300),
		big,
		[]byte("tail"),
	}
	want := bytes.Join(payloads, nil)

	w, err := newV6Writer(&conn, mode, psk, profile)
	if err != nil {
		t.Fatalf("newV6Writer: %v", err)
	}
	for _, p := range payloads {
		if _, err := w.Write(p); err != nil {
			t.Fatalf("write: %v", err)
		}
	}
	if err := w.writeZeroChunk(); err != nil {
		t.Fatalf("zero chunk: %v", err)
	}

	r := newV6Reader(&conn, mode, psk, profile)
	got := make([]byte, 0, len(want))
	buf := make([]byte, 4096)
	for {
		n, err := r.Read(buf)
		got = append(got, buf[:n]...)
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatalf("read: %v", err)
		}
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("mode %s round trip mismatch: got %d want %d", mode, len(got), len(want))
	}
}

func TestV6RoundTripDefault(t *testing.T)  { v6RoundTrip(t, ModeDefault) }
func TestV6RoundTripUnshaped(t *testing.T) { v6RoundTrip(t, ModeUnshaped) }
func TestV6RoundTripRaw(t *testing.T)      { v6RoundTrip(t, ModeUnsafeRaw) }

// v6Datagram 验证单 record 数据报往返(UDP 路径:writeDatagram → nextRecord)。
func v6Datagram(t *testing.T, mode Mode) {
	t.Helper()
	psk := []byte("v6-shared-psk-123456")
	var profile *Profile
	if mode == ModeDefault {
		profile = NewProfile(psk)
	}
	var conn bytes.Buffer
	dgrams := [][]byte{[]byte("dns-query-1"), bytes.Repeat([]byte("x"), 1400), []byte("q3")}

	w, err := newV6Writer(&conn, mode, psk, profile)
	if err != nil {
		t.Fatal(err)
	}
	for _, d := range dgrams {
		if err := w.writeDatagram(d); err != nil {
			t.Fatalf("writeDatagram: %v", err)
		}
	}

	r := newV6Reader(&conn, mode, psk, profile)
	for i, want := range dgrams {
		got, err := r.nextRecord()
		if err != nil {
			t.Fatalf("nextRecord %d: %v", i, err)
		}
		if !bytes.Equal(got, want) {
			t.Fatalf("mode %s datagram %d mismatch", mode, i)
		}
	}
}

func TestV6DatagramDefault(t *testing.T)  { v6Datagram(t, ModeDefault) }
func TestV6DatagramUnshaped(t *testing.T) { v6Datagram(t, ModeUnshaped) }
func TestV6DatagramRaw(t *testing.T)      { v6Datagram(t, ModeUnsafeRaw) }

// TestV6WrongPSK:default/unshaped 用错 psk 读应失败(salt/AEAD 不匹配)。
func TestV6WrongPSK(t *testing.T) {
	for _, mode := range []Mode{ModeDefault, ModeUnshaped} {
		psk := []byte("correct-psk-1234567")
		wrong := []byte("wrong-psk-99999999")
		var pw, pr *Profile
		if mode == ModeDefault {
			pw = NewProfile(psk)
			pr = NewProfile(wrong)
		}
		var conn bytes.Buffer
		w, err := newV6Writer(&conn, mode, psk, pw)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := w.Write([]byte("secret")); err != nil {
			t.Fatal(err)
		}
		r := newV6Reader(&conn, mode, wrong, pr)
		if _, err := r.Read(make([]byte, 64)); err == nil {
			t.Fatalf("mode %s: expected failure with wrong psk", mode)
		}
	}
}

func v6UserWithPSK(psk string) *protocol.MemoryUser {
	return &protocol.MemoryUser{Account: &MemoryAccount{PSK: []byte(psk), Version: 6}}
}

// v6WriteFirstRecord 用给定 psk(default 模式带 profile)写出一个含握手请求的首个 record。
func v6WriteFirstRecord(t *testing.T, mode Mode, psk string, dest net.Destination) *bytes.Buffer {
	t.Helper()
	var profile *Profile
	if mode == ModeDefault {
		profile = NewProfile([]byte(psk))
	}
	conn := &bytes.Buffer{}
	w, err := newV6Writer(conn, mode, []byte(psk), profile)
	if err != nil {
		t.Fatal(err)
	}
	var reqBuf bytes.Buffer
	if err := (request{command: commandConnect, destination: dest}).writeTo(&reqBuf); err != nil {
		t.Fatal(err)
	}
	if _, err := w.Write(reqBuf.Bytes()); err != nil {
		t.Fatal(err)
	}
	return conn
}

// TestV6IdentifyPerUserPSK:v6 多用户 —— 服务端必须靠"逐 PSK 试解首个 record"定位到实际连接的用户
// (而非回落 users[0]),这是 per-user 流量统计 / 限速 / 限连接数的前提。default/unshaped 均验证;
// 另验:不在用户列表的 psk 被拒;raw 模式无密钥回落 users[0] 且不消费任何字节。
func TestV6IdentifyPerUserPSK(t *testing.T) {
	dest := net.TCPDestination(net.ParseAddress("example.com"), 443)
	pskA, pskB, pskC := "user-a-psk-11111111", "user-b-psk-22222222", "user-c-psk-33333333"

	for _, mode := range []Mode{ModeDefault, ModeUnshaped} {
		userA, userB, userC := v6UserWithPSK(pskA), v6UserWithPSK(pskB), v6UserWithPSK(pskC)
		s := &Server{users: []*protocol.MemoryUser{userA, userB, userC}, v6Mode: mode}

		// 客户端用 userB 的 psk 发首个 record;服务端必须定位到 B。
		conn := v6WriteFirstRecord(t, mode, pskB, dest)
		user, profile, head, err := s.identifyV6User(conn)
		if err != nil {
			t.Fatalf("mode %s identify: %v", mode, err)
		}
		if user != userB {
			t.Fatalf("mode %s: 定位到错误用户(应为 B)", mode)
		}
		// 用识别结果 + head 重建 reader,应能解出握手请求(证明 head 拼接与 psk 一致)。
		r := newV6Reader(io.MultiReader(bytes.NewReader(head), conn), mode, user.Account.(*MemoryAccount).PSK, profile)
		req, err := readRequest(r)
		if err != nil {
			t.Fatalf("mode %s readRequest: %v", mode, err)
		}
		if req.destination.Address.String() != "example.com" || req.destination.Port != 443 {
			t.Fatalf("mode %s dest 不匹配: %v", mode, req.destination)
		}

		// 不在用户列表里的 psk 必须被拒(而非误判成某个用户)。
		stranger := v6WriteFirstRecord(t, mode, "stranger-psk-000000", dest)
		if u, _, _, err := s.identifyV6User(stranger); err == nil {
			t.Fatalf("mode %s: 陌生 psk 应被拒,却定位到 %p", mode, u)
		}
	}

	// raw 模式无任何密钥,无法区分用户 → 回落 users[0],且不读取任何字节。
	userA := v6UserWithPSK(pskA)
	sRaw := &Server{users: []*protocol.MemoryUser{userA, v6UserWithPSK(pskB)}, v6Mode: ModeUnsafeRaw}
	user, _, head, err := sRaw.identifyV6User(&bytes.Buffer{})
	if err != nil || user != userA || head != nil {
		t.Fatalf("raw 应回落 users[0] 且不消费: userA=%v head=%v err=%v", user == userA, head, err)
	}
}

// TestV6RequestInFirstRecord:握手请求 + payload 同流,server 端 readRequest 后读剩余(仿真实 clientID 流)。
func TestV6RequestInFirstRecord(t *testing.T) {
	psk := []byte("v6-shared-psk-123456")
	profile := NewProfile(psk)
	dest := net.TCPDestination(net.ParseAddress("example.com"), 443)
	appData := bytes.Repeat([]byte("payload-"), 5000)

	var conn bytes.Buffer
	w, err := newV6Writer(&conn, ModeDefault, psk, profile)
	if err != nil {
		t.Fatal(err)
	}
	var reqBuf bytes.Buffer
	if err := (request{command: commandConnect, clientID: []byte("uid7"), destination: dest}).writeTo(&reqBuf); err != nil {
		t.Fatal(err)
	}
	if _, err := w.Write(reqBuf.Bytes()); err != nil {
		t.Fatal(err)
	}
	if _, err := w.Write(appData); err != nil {
		t.Fatal(err)
	}

	r := newV6Reader(&conn, ModeDefault, psk, profile)
	req, err := readRequest(r)
	if err != nil {
		t.Fatalf("readRequest: %v", err)
	}
	if req.destination.Address.String() != "example.com" || req.destination.Port != 443 {
		t.Fatalf("dest mismatch: %v", req.destination)
	}
	if !bytes.Equal(req.clientID, []byte("uid7")) {
		t.Fatalf("clientID mismatch: %q", req.clientID)
	}
	rest, err := io.ReadAll(r)
	if err != nil {
		t.Fatalf("read rest: %v", err)
	}
	if !bytes.Equal(rest, appData) {
		t.Fatalf("payload mismatch: got %d want %d", len(rest), len(appData))
	}
}
