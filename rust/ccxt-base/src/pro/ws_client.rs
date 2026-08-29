//! WebSocket transport for the pro (`watch*`) API.
//!
//! This is the Rust port of the runtime side of `ts/src/base/ws/{Client,WsClient}.ts`.
//! The transpiled `pro/<id>.rs` exchanges call — via the base `watch()` /
//! `watch_multiple()` — into a *client* object keyed by URL that:
//!   * owns the live `tokio-tungstenite` connection (one per exchange + URL),
//!   * exposes `resolve` / `reject` / `future` / `send` so the venue's
//!     `handle_message` can push parsed data back to the awaiting `watch`,
//!   * tracks `subscriptions` (so a subscribe frame is sent once per hash),
//!   * runs ping/pong keep-alive.
//!
//! Ownership model (why this registry is process-wide but instance-keyed):
//! the base `watch()` borrows `&mut self` to drive `handle_message`, which
//! itself needs the client. Keeping the connection + futures in a process-wide
//! registry keyed by `(exchange owner id, URL)` (behind its own locks) keeps it disjoint from the
//! `&mut Exchange` borrow, so the drive loop can read the next frame and call
//! `handle_message(self, client, msg)` without aliasing.

#![allow(dead_code)]

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, Mutex};

use futures::{SinkExt, StreamExt};
use once_cell::sync::Lazy;
use tokio::sync::{mpsc, Notify};
use tokio_tungstenite::tungstenite::Message;

use crate::Value;

/// Per-connection state. Lives in [`REGISTRY`] behind an `Arc`, so both the
/// background reader/writer tasks and the `watch` drive loop share it.
pub struct ClientState {
    pub owner_id: u64,
    pub url: String,
    /// Frames queued for the writer task → socket.
    outgoing: Mutex<mpsc::Sender<Message>>,
    /// Bounded receiver retained until the socket connects. This preserves the
    /// pre-connect send contract while avoiding the old unbounded queue.
    pending_rx: Mutex<Option<mpsc::Receiver<Message>>>,
    /// Serializes the (async) connect so concurrent `ensure_client`s for a
    /// pre-registered slot don't open two sockets.
    connect_gate: tokio::sync::Mutex<()>,
    /// Parsed inbound messages awaiting dispatch to `handle_message`.
    incoming: Mutex<VecDeque<Value>>,
    /// Woken on: new inbound message, a resolve/reject, or close.
    notify: Notify,
    /// messageHash → resolved value (set by `handle_message` via `resolve`).
    resolved: Mutex<HashMap<String, Value>>,
    /// messageHash → error (set by `reject`; delivered before/instead of value).
    rejections: Mutex<HashMap<String, Value>>,
    /// subscribeHash → subscription object (TS `client.subscriptions[hash]`).
    /// A subscribe frame is sent only the first time a hash is inserted.
    subscriptions: Mutex<HashMap<String, Value>>,
    /// Subscribe frames retained for replay after a transport reconnect.
    /// Insertion-ordered so replay reproduces the original frame order — venues
    /// that subscribe in a fixed sequence depend on it (a `HashMap` here made
    /// the replay order vary run to run).
    subscribe_messages: Mutex<indexmap::IndexMap<String, String>>,
    /// messageHashes some `watch` call is currently waiting on. Mirrors TS
    /// `client.futures` (read by a few venues' `handle_message`).
    futures: Mutex<HashSet<String>>,
    connected: Mutex<bool>,
    closed: Mutex<bool>,
    last_pong_ms: Mutex<i64>,
    /// Identity of the currently-live socket, bumped on every successful
    /// connect. The reader / writer / keep-alive tasks capture their generation
    /// and stand down once it no longer matches, so tasks belonging to a
    /// superseded socket can neither push stale frames into `incoming` nor
    /// fail the connection that replaced them.
    generation: std::sync::atomic::AtomicU64,
    /// Static-WS-test mock transport. When `mock` is set, `send_text` records the
    /// (JSON-parsed) outgoing frame into `mock_sent` instead of relying on a
    /// socket, and no real connection is ever opened. `ws_test_completed` is the
    /// watch side's done-flag the frame injector's rejection loop polls.
    mock: Mutex<bool>,
    mock_sent: Mutex<Vec<Value>>,
    ws_test_completed: Mutex<bool>,
}

const OUTGOING_CAPACITY: usize = 1024;
const INCOMING_CAPACITY: usize = 4096;
const SETTLED_CAPACITY: usize = 4096;
const KEEP_ALIVE_MS: u64 = 30_000;
const MAX_PING_PONG_MISSES: i64 = 2;

type ClientKey = (u64, String);
static REGISTRY: Lazy<Mutex<HashMap<ClientKey, Arc<ClientState>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
/// URLs armed for the mock transport by `mock_setup`. An entry is CONSUMED by
/// the next `ensure_slot` that creates a client for it, so a fixture can never
/// silently mock a genuine connection opened later in the same process.
static MOCK_URLS: Lazy<Mutex<HashSet<String>>> = Lazy::new(|| Mutex::new(HashSet::new()));
/// Frames injected for a URL whose client does not exist yet. The static-WS
/// harness preloads the whole fixture *before* the first `watch*` call creates
/// the slot, and the registry is keyed by `(owner_id, url)` which the URL-keyed
/// mock façade cannot construct — so injections land here and `ensure_slot`
/// drains them into the client the case actually uses.
static MOCK_PENDING: Lazy<Mutex<HashMap<String, Vec<Value>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// Monotonic-ish wall clock in ms. `SystemTime` is fine here (keep-alive only).
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Decode a text frame into a `Value` — JSON when it parses, else a raw string
/// (some venues send bare `"pong"` etc. that `handle_message` matches on).
fn parse_text(t: &str) -> Value {
    match serde_json::from_str::<serde_json::Value>(t) {
        Ok(j) => Value::from_json(&j),
        Err(_) => Value::Str(t.to_string()),
    }
}

/// Decode a binary frame: try raw-inflate then gzip (the two schemes venues
/// use), fall back to the bytes as UTF-8. Then parse as text.
fn parse_binary(b: &[u8]) -> Value {
    use std::io::Read;
    // gzip
    {
        let mut d = flate2::read::GzDecoder::new(b);
        let mut s = String::new();
        if d.read_to_string(&mut s).is_ok() && !s.is_empty() {
            return parse_text(&s);
        }
    }
    // raw deflate (no zlib header)
    {
        let mut d = flate2::read::DeflateDecoder::new(b);
        let mut s = String::new();
        if d.read_to_string(&mut s).is_ok() && !s.is_empty() {
            return parse_text(&s);
        }
    }
    // Uncompressed and valid UTF-8 → parse as text/JSON (covers venues that
    // send plain-JSON frames over the binary opcode).
    if let Ok(s) = std::str::from_utf8(b) {
        return parse_text(s);
    }
    // Genuine binary payload (e.g. mexc protobuf): carry the raw bytes through
    // as the port's byte-array form so `isBinaryMessage`/`decodeProtoMsg` see them.
    crate::exchange_stubs::bytes_to_value(b)
}

impl ClientState {
    fn push_incoming(&self, v: Value) {
        let mut queue = self.incoming.lock().unwrap();
        if queue.len() >= INCOMING_CAPACITY {
            drop(queue);
            self.fail_transport(Value::Str(
                "[NetworkError] websocket incoming queue capacity exceeded".to_string(),
            ));
            return;
        }
        queue.push_back(v);
        self.notify.notify_waiters();
    }

    /// Await the next inbound message. `None` once the socket is closed and
    /// the backlog is drained. Uses the create-future-before-check pattern so
    /// a resolve/push racing the await is never lost.
    pub async fn next_message(&self) -> Option<Value> {
        let mock = *self.mock.lock().unwrap();
        loop {
            let notified = self.notify.notified();
            if let Some(v) = self.incoming.lock().unwrap().pop_front() {
                return Some(v);
            }
            if *self.closed.lock().unwrap() || !*self.connected.lock().unwrap() {
                return None;
            }
            if mock {
                // Static WS test: the mock queue is fed by the frame injector.
                // If nothing arrives within a short window the fixture is
                // finished (or under-feeds this watch) — stop instead of
                // blocking the drive loop forever, so the test completes.
                if tokio::time::timeout(std::time::Duration::from_millis(1500), notified)
                    .await
                    .is_err()
                {
                    return None;
                }
            } else {
                notified.await;
            }
        }
    }

    /// Store a resolved value for `hash` (TS `client.resolve`).
    pub fn resolve(&self, hash: &str, value: Value) {
        if self.futures.lock().unwrap().remove(hash) {
            let mut resolved = self.resolved.lock().unwrap();
            if resolved.len() >= SETTLED_CAPACITY {
                resolved.clear();
            }
            resolved.insert(hash.to_string(), value);
        }
        self.notify.notify_waiters();
    }

    /// Store an error for `hash` (TS `client.reject`).
    pub fn reject(&self, hash: &str, err: Value) {
        self.futures.lock().unwrap().remove(hash);
        let mut rejections = self.rejections.lock().unwrap();
        if rejections.len() >= SETTLED_CAPACITY {
            rejections.clear();
        }
        rejections.insert(hash.to_string(), err);
        self.notify.notify_waiters();
    }

    /// Settle the watch that registered `hashes`: if any has a resolved value or
    /// rejection, remove and return it (`Ok` for value, `Err` for rejection,
    /// rejections first) and retire the losing hashes.
    pub fn take_settled(&self, hashes: &[String]) -> Option<Result<Value, Value>> {
        self.take_settled_inner(hashes, true)
    }

    /// Same, but leaves the pending set untouched. For a caller polling hashes
    /// it does not own — a nested `watch` on a url an ancestor loop is already
    /// driving registers the hashes but never awaits them, so retiring here
    /// would drop the ancestor's registration and silently discard every later
    /// resolve for it.
    pub fn take_settled_no_retire(&self, hashes: &[String]) -> Option<Result<Value, Value>> {
        self.take_settled_inner(hashes, false)
    }

    fn take_settled_inner(
        &self,
        hashes: &[String],
        retire: bool,
    ) -> Option<Result<Value, Value>> {
        {
            let mut settled = None;
            {
                let mut rj = self.rejections.lock().unwrap();
                for h in hashes {
                    if let Some(e) = rj.remove(h) {
                        settled = Some(e);
                        break;
                    }
                }
            }
            if let Some(e) = settled {
                if retire {
                    self.retire_futures(hashes);
                }
                return Some(Err(e));
            }
        }
        let mut r = self.resolved.lock().unwrap();
        for h in hashes {
            if let Some(v) = r.remove(h) {
                drop(r);
                // The watch that registered `hashes` is a race: once one of them
                // settles the others are dead. Retire them so they don't sit in
                // `futures` forever, which would let a later blanket `reject`
                // record an error under a hash nobody is waiting on and hand it
                // to an unrelated watch on that hash.
                if retire {
                    self.retire_futures(hashes);
                }
                return Some(Ok(v));
            }
        }
        None
    }

    /// Drop `hashes` from the pending set without settling them.
    fn retire_futures(&self, hashes: &[String]) {
        let mut f = self.futures.lock().unwrap();
        for h in hashes {
            f.remove(h);
        }
    }

    /// Register interest in `hashes` (TS `client.future`). Returns true if the
    /// subscribe frame still needs sending for `subscribe_hash`.
    pub fn note_futures(&self, hashes: &[String]) {
        let mut f = self.futures.lock().unwrap();
        for h in hashes {
            f.insert(h.clone());
        }
    }

    /// Record `subscribe_hash` → `subscription`; returns true the first time
    /// (so the caller sends the subscribe frame exactly once). Mirrors TS
    /// `client.subscriptions[subscribeHash] = subscription || true`.
    pub fn subscribe_once(&self, subscribe_hash: &str, subscription: Value) -> bool {
        let mut subs = self.subscriptions.lock().unwrap();
        if subs.contains_key(subscribe_hash) {
            return false;
        }
        let stored = if matches!(subscription, Value::Null) {
            Value::Bool(true)
        } else {
            subscription
        };
        subs.insert(subscribe_hash.to_string(), stored);
        true
    }

    pub fn remember_subscribe_message(&self, subscribe_hashes: &[String], payload: String) {
        let mut messages = self.subscribe_messages.lock().unwrap();
        if subscribe_hashes.is_empty() {
            messages.insert(payload.clone(), payload);
        } else {
            for hash in subscribe_hashes {
                messages.insert(hash.clone(), payload.clone());
            }
        }
    }

    /// Directly set a subscription entry (TS `client.subscriptions[h] = x`
    /// written from `handle_message`).
    pub fn set_subscription(&self, subscribe_hash: &str, subscription: Value) {
        self.subscriptions
            .lock()
            .unwrap()
            .insert(subscribe_hash.to_string(), subscription);
    }

    pub fn is_subscribed(&self, subscribe_hash: &str) -> bool {
        self.subscriptions
            .lock()
            .unwrap()
            .contains_key(subscribe_hash)
    }

    pub fn send_text(&self, s: String) -> bool {
        if std::env::var("CCXT_WS_DEBUG").is_ok() {
            eprintln!("[wssend] {}", s.chars().take(200).collect::<String>());
        }
        // Static-WS-test mock transport: record the frame (JSON-parsed, like the
        // TS `client.connection.send` stub) instead of hitting a socket.
        if *self.mock.lock().unwrap() {
            self.mock_sent.lock().unwrap().push(parse_text(&s));
            return true;
        }
        let sender = self.outgoing.lock().unwrap().clone();
        let sent = sender.try_send(Message::Text(s)).is_ok();
        if !sent {
            self.fail_transport(Value::Str(
                "[NetworkError] websocket outgoing queue capacity exceeded".to_string(),
            ));
        }
        sent
    }

    /// Enable the mock transport: mark connected (so `ensure_client` never opens
    /// a socket) and route `send_text` to the capture buffer.
    pub fn mock_enable(&self) {
        *self.mock.lock().unwrap() = true;
        *self.connected.lock().unwrap() = true;
    }
    /// Injected inbound frame → the same queue the socket reader feeds.
    pub fn mock_inject(&self, msg: Value) {
        self.incoming.lock().unwrap().push_back(msg);
        self.notify.notify_one();
    }
    /// The captured outgoing frames as a `Value::List`.
    pub fn mock_sent_value(&self) -> Value {
        Value::Array(self.mock_sent.lock().unwrap().clone())
    }
    pub fn has_pending_futures(&self) -> bool {
        !self.futures.lock().unwrap().is_empty()
    }
    /// Whether the mock inbound queue still holds un-consumed frames.
    pub fn has_queued_messages(&self) -> bool {
        !self.incoming.lock().unwrap().is_empty()
    }
    pub fn mark_ws_test_completed(&self) {
        *self.ws_test_completed.lock().unwrap() = true;
    }
    pub fn is_ws_test_completed(&self) -> bool {
        *self.ws_test_completed.lock().unwrap()
    }
    /// Reject every pending future so a fixture whose frames don't resolve the
    /// watch fails (with a message) rather than hanging the drive loop.
    pub fn reject_pending_futures(&self, err: Value) {
        let hashes: Vec<String> = self.futures.lock().unwrap().iter().cloned().collect();
        for h in hashes {
            self.reject(&h, err.clone());
        }
    }

    pub fn is_closed(&self) -> bool {
        *self.closed.lock().unwrap()
    }

    /// Whether this client uses the socket-less static-WS mock transport.
    pub fn is_mock(&self) -> bool {
        *self.mock.lock().unwrap()
    }

    fn generation(&self) -> u64 {
        self.generation.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// Retire the current socket's generation, so its reader / writer /
    /// keep-alive tasks stand down instead of acting on the connection that
    /// replaces them.
    fn bump_generation(&self) -> u64 {
        self.generation
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
            + 1
    }

    pub fn on_pong(&self) {
        *self.last_pong_ms.lock().unwrap() = now_ms();
    }

    fn pong_timed_out(&self, now: i64, keep_alive_ms: u64) -> bool {
        now.saturating_sub(*self.last_pong_ms.lock().unwrap())
            > (keep_alive_ms as i64).saturating_mul(MAX_PING_PONG_MISSES)
    }

    fn fail_transport(&self, err: Value) {
        // Retire the generation FIRST: the socket behind a failed transport may
        // still be open (an overflowed outgoing queue or a missed pong says
        // nothing about the peer), and without this its reader would keep
        // feeding `incoming` alongside the reader of the replacement socket —
        // every frame dispatched to `handle_message` twice.
        self.bump_generation();
        *self.connected.lock().unwrap() = false;
        self.prepare_reconnect_channel();
        self.reject_pending_futures(err);
        self.notify.notify_waiters();
    }

    fn prepare_reconnect_channel(&self) {
        let (tx, rx) = mpsc::channel(OUTGOING_CAPACITY);
        // Best-effort: ask the outgoing writer to close its socket so the
        // superseded connection is torn down rather than left parked on
        // `rx.recv()`. Best-effort because the two `fail_transport` paths that
        // fire *on a full outgoing queue* cannot queue anything more — there the
        // socket is reclaimed when the writer's next send fails, or when the
        // retired generation stops its keep-alive from holding the sender alive.
        let previous = std::mem::replace(&mut *self.outgoing.lock().unwrap(), tx);
        let _ = previous.try_send(Message::Close(None));
        *self.pending_rx.lock().unwrap() = Some(rx);
    }

    /// Drop resolved/rejected/subscription/future state (TS `client.reset`),
    /// e.g. after a reconnect so stale hashes don't resolve new waiters.
    pub fn reset(&self) {
        self.resolved.lock().unwrap().clear();
        self.rejections.lock().unwrap().clear();
        self.subscriptions.lock().unwrap().clear();
        self.subscribe_messages.lock().unwrap().clear();
        self.futures.lock().unwrap().clear();
    }

    /// Snapshot of `subscriptions` as a `Value::Map { hash: subscription }` —
    /// the shape the transpiled `get_value(&client, "subscriptions")` reads.
    /// Tagged with `__ws_subs_url` so that writes performed on the snapshot
    /// (`client.subscriptions[chanId] = …`, common in bitfinex/chan-id venues)
    /// route back to this live `ClientState` instead of a discarded clone.
    pub fn subscriptions_value(&self) -> Value {
        let subs = self.subscriptions.lock().unwrap();
        let mut m = indexmap::IndexMap::new();
        m.insert(
            "__ws_owner_id".to_string(),
            Value::Int(self.owner_id as i64),
        );
        m.insert("__ws_subs_url".to_string(), Value::Str(self.url.clone()));
        for (h, sub) in subs.iter() {
            // Tag each subscription DICT with a back-reference so a field write
            // on it (`subscription['receivedSnapshot'] = true`) persists to this
            // live client — venues mutate a subscription retrieved from
            // client.subscriptions and rely on JS object identity.
            let tagged = match sub {
                Value::Dict(d) => {
                    let mut inner = (**d).clone();
                    inner.insert(
                        "__ws_owner_id".to_string(),
                        Value::Int(self.owner_id as i64),
                    );
                    inner.insert("__ws_sub_url".to_string(), Value::Str(self.url.clone()));
                    inner.insert("__ws_sub_ref".to_string(), Value::Str(h.clone()));
                    Value::Dict(std::sync::Arc::new(inner))
                }
                other => other.clone(),
            };
            m.insert(h.clone(), tagged);
        }
        Value::Map(m)
    }

    /// Set a field on a stored subscription dict (`client.subscriptions[hash]
    /// [key] = val`). Creates the entry if missing.
    pub fn set_subscription_field(&self, hash: &str, key: &str, val: Value) {
        let mut subs = self.subscriptions.lock().unwrap();
        match subs.get_mut(hash) {
            Some(Value::Dict(d)) => {
                std::sync::Arc::make_mut(d).insert(key.to_string(), val);
            }
            _ => {
                let mut inner = indexmap::IndexMap::new();
                inner.insert(key.to_string(), val);
                subs.insert(hash.to_string(), Value::Dict(std::sync::Arc::new(inner)));
            }
        }
    }

    /// Snapshot of `futures` as a `Value::Map { hash: true }`.
    pub fn futures_value(&self) -> Value {
        let f = self.futures.lock().unwrap();
        let mut m = indexmap::IndexMap::new();
        for h in f.iter() {
            // Each entry is a future *handle* carrying the url + its own hash, so
            // transpiled `client.futures[hash].resolve(x)` (bitget/cryptocom auth)
            // routes back to this ClientState — see value_resolve/value_reject.
            let mut fh = indexmap::IndexMap::new();
            fh.insert("url".to_string(), Value::Str(self.url.clone()));
            fh.insert(
                "__ws_owner_id".to_string(),
                Value::Int(self.owner_id as i64),
            );
            fh.insert("__ws_future_hash".to_string(), Value::Str(h.clone()));
            m.insert(h.clone(), Value::Map(fh));
        }
        Value::Map(m)
    }
}

/// Get the existing client for `url`, or `None` if not yet connected.
pub fn get_client(owner_id: u64, url: &str) -> Option<Arc<ClientState>> {
    let reg = REGISTRY.lock().unwrap();
    reg.get(&(owner_id, url.to_string()))
        .filter(|c| !c.is_closed())
        .cloned()
}

/// `client.subscriptions[key] = val` written on a tagged snapshot — persist it
/// to the live client so subsequent `handle_message` snapshots see it.
pub fn value_subs_insert(owner_id: u64, url: &str, key: &str, val: Value) {
    if let Some(c) = get_client(owner_id, url) {
        c.set_subscription(key, val);
    }
}

/// `delete client.subscriptions[key]` on a tagged snapshot.
pub fn value_subs_remove(owner_id: u64, url: &str, key: &str) {
    if let Some(c) = get_client(owner_id, url) {
        c.subscriptions.lock().unwrap().remove(key);
    }
}

/// `client.subscriptions[hash][key] = val` written on a tagged subscription
/// dict (carrying `__ws_sub_ref` = "url\u{1}hash").
pub fn value_sub_field_write(owner_id: u64, url: &str, hash: &str, key: &str, val: Value) {
    if let Some(c) = get_client(owner_id, url) {
        c.set_subscription_field(hash, key, val);
    }
}

/// Ensure a live connection to `url`, connecting (and spawning the reader /
/// writer / keep-alive tasks) if needed. Idempotent per URL.
pub async fn ensure_client(owner_id: u64, url: &str) -> Result<Arc<ClientState>, String> {
    let state = ensure_slot(owner_id, url);
    if *state.connected.lock().unwrap() {
        return Ok(state);
    }
    // Serialize connect; re-check under the gate (another task may have just
    // connected this slot). Lock via a cloned Arc so `state` stays movable.
    let gate_holder = state.clone();
    let _gate = gate_holder.connect_gate.lock().await;
    if *state.connected.lock().unwrap() {
        return Ok(state);
    }
    let (ws, _resp) = tokio_tungstenite::connect_async(url)
        .await
        .map_err(|e| format!("[NetworkError] ws connect {url}: {e}"))?;
    let (mut write, mut read) = ws.split();
    let mut rx = state
        .pending_rx
        .lock()
        .unwrap()
        .take()
        .ok_or_else(|| format!("[NetworkError] ws {url} slot has no writer channel"))?;
    let tx = state.outgoing.lock().unwrap().clone();
    *state.last_pong_ms.lock().unwrap() = now_ms();
    // Claim a generation for this socket. Every task spawned below stands down
    // as soon as `generation` moves past `gen`, so a task belonging to a
    // superseded socket can neither feed `incoming` nor fail its replacement.
    let gen = state.bump_generation();
    *state.connected.lock().unwrap() = true;

    // Writer task: drain the outgoing queue to the socket.
    tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            let closing = matches!(msg, Message::Close(_));
            if write.send(msg).await.is_err() || closing {
                break;
            }
        }
        let _ = write.close().await;
    });

    // Reader task: decode frames → incoming queue.
    let st = state.clone();
    tokio::spawn(async move {
        while let Some(frame) = read.next().await {
            if st.generation() != gen {
                break; // superseded socket — its frames are not ours to deliver
            }
            match frame {
                Ok(Message::Text(t)) => st.push_incoming(parse_text(&t)),
                Ok(Message::Binary(b)) => st.push_incoming(parse_binary(&b)),
                Ok(Message::Pong(_)) => st.on_pong(),
                // tungstenite answers Ping frames with Pong automatically.
                Ok(Message::Ping(_)) => {}
                Ok(Message::Close(_)) | Err(_) => break,
                _ => {}
            }
        }
        if !st.is_closed() && st.generation() == gen {
            st.bump_generation();
            *st.connected.lock().unwrap() = false;
            st.prepare_reconnect_channel();
            st.notify.notify_waiters();
        }
    });

    // Keep-alive: an unsolicited Ping every 30s; the peer's Pong updates
    // last_pong. (Full miss-count RequestTimeout handling is a later refinement.)
    let st2 = state.clone();
    tokio::spawn(async move {
        let mut iv = tokio::time::interval(std::time::Duration::from_millis(KEEP_ALIVE_MS));
        iv.tick().await; // first tick fires immediately; skip it
        loop {
            iv.tick().await;
            // `generation` is the load-bearing check: a reconnect between two
            // ticks leaves `connected` true again, so without it this task would
            // outlive its socket and fail the healthy connection that replaced
            // it once its own (now dead) channel started erroring.
            if st2.is_closed() || st2.generation() != gen || !*st2.connected.lock().unwrap() {
                break;
            }
            if st2.pong_timed_out(now_ms(), KEEP_ALIVE_MS) {
                st2.fail_transport(Value::Str(format!(
                    "[RequestTimeout] Connection to {} timed out due to a ping-pong keepalive missing on time", st2.url)));
                break;
            }
            if tx.try_send(Message::Ping(Vec::new())).is_err() {
                st2.fail_transport(Value::Str(format!(
                    "[NetworkError] Connection to {} could not queue a keepalive ping",
                    st2.url
                )));
                break;
            }
        }
    });
    // Replay one copy of every retained subscription frame after reconnect, in
    // the order they were first sent.
    //
    // NOTE: only frames sent by `watch()` are retained. A frame a venue emits
    // from `handle_message` via `client.send(...)` — notably a private stream's
    // auth/login — is not replayed, so such a stream comes back unauthenticated
    // after a reconnect. Widening replay to arbitrary sent frames would also
    // replay one-shot frames (unsubscribes, pongs), so it needs a venue-level
    // notion of which frames are re-sendable rather than a blanket capture.
    let mut seen: HashSet<String> = HashSet::new();
    let messages: Vec<String> = state
        .subscribe_messages
        .lock()
        .unwrap()
        .values()
        .filter(|payload| seen.insert((*payload).clone()))
        .cloned()
        .collect();
    for payload in messages {
        if !state.send_text(payload) {
            return Err(format!("[NetworkError] ws {url} outgoing queue full"));
        }
    }
    Ok(state)
}

/// Live read of a client handle's `subscriptions` / `futures` field, straight
/// from the registry so a read after a write (upbit builds its subscribe frame
/// from subscriptions it just set) is coherent, not a stale embedded snapshot.
pub fn client_field_live(owner_id: u64, url: &str, field: &str) -> Value {
    match get_client(owner_id, url) {
        Some(c) if field == "futures" => c.futures_value(),
        Some(c) => c.subscriptions_value(),
        None => Value::Map(indexmap::IndexMap::new()),
    }
}

/// Get-or-create the registry slot for `url` WITHOUT connecting the socket, so
/// `client.subscriptions` written before `watch()` connects still persist.
fn ensure_slot(owner_id: u64, url: &str) -> Arc<ClientState> {
    let mut reg = REGISTRY.lock().unwrap();
    let key = (owner_id, url.to_string());
    if let Some(c) = reg.get(&key) {
        if !c.is_closed() {
            return c.clone();
        }
    }
    let (tx, rx) = mpsc::channel::<Message>(OUTGOING_CAPACITY);
    let state = Arc::new(ClientState {
        owner_id,
        url: url.to_string(),
        outgoing: Mutex::new(tx),
        pending_rx: Mutex::new(Some(rx)),
        connect_gate: tokio::sync::Mutex::new(()),
        incoming: Mutex::new(VecDeque::new()),
        notify: Notify::new(),
        resolved: Mutex::new(HashMap::new()),
        rejections: Mutex::new(HashMap::new()),
        subscriptions: Mutex::new(HashMap::new()),
        subscribe_messages: Mutex::new(indexmap::IndexMap::new()),
        futures: Mutex::new(HashSet::new()),
        connected: Mutex::new(false),
        closed: Mutex::new(false),
        last_pong_ms: Mutex::new(now_ms()),
        generation: std::sync::atomic::AtomicU64::new(0),
        mock: Mutex::new(false),
        mock_sent: Mutex::new(Vec::new()),
        ws_test_completed: Mutex::new(false),
    });
    // Consume the arm rather than just reading it: the fixture that called
    // `mock_setup` wants exactly this one client mocked. Leaving the URL armed
    // would silently mock a genuine connection opened later in the process.
    if MOCK_URLS.lock().unwrap().remove(url) {
        state.mock_enable();
        // Frames the harness preloaded before this slot existed.
        if let Some(pending) = MOCK_PENDING.lock().unwrap().remove(url) {
            let mut queue = state.incoming.lock().unwrap();
            queue.extend(pending);
        }
    }
    reg.insert(key, state.clone());
    state
}

/// Remove (and thereby drop / disconnect) the client for `url`.
pub fn drop_client(owner_id: u64, url: &str) {
    if let Some(state) = REGISTRY
        .lock()
        .unwrap()
        .remove(&(owner_id, url.to_string()))
    {
        *state.closed.lock().unwrap() = true;
        state.reject_pending_futures(Value::Str(
            "[ExchangeClosedByUser] websocket client closed".to_string(),
        ));
        let _ = state
            .outgoing
            .lock()
            .unwrap()
            .try_send(Message::Close(None));
        state.notify.notify_waiters();
    }
}

pub fn close_owner(owner_id: u64) {
    let urls: Vec<String> = REGISTRY
        .lock()
        .unwrap()
        .keys()
        .filter(|(owner, _)| *owner == owner_id)
        .map(|(_, url)| url.clone())
        .collect();
    for url in urls {
        drop_client(owner_id, &url);
    }
}

// ── `Value`-handle bridge ────────────────────────────────────────────────────
//
// The transpiled `handle_message(&mut self, client: Value, message: Value)`
// receives a *client* as a `Value`. We model it as `Value::Map { "url": <url>,
// "subscriptions": <snapshot>, "futures": <snapshot> }`. The `Value` methods
// `resolve`/`reject`/`send`/… (in value.rs) extract `url` and route here.

// ── Static-WS-test mock transport (url-keyed façade over ClientState) ────────

/// `setupWsMockTransport(url)` — arm the mock transport for `url` so the next
/// client created for it is connected and socket-less with its sends captured.
///
/// The harness rebuilds the exchange Core per case, so each case is a NEW
/// `ws_owner_id` and this URL-keyed façade cannot name the `(owner_id, url)`
/// slot the case will use. It therefore arms the URL and evicts the clients
/// left behind by earlier cases, so exactly one client per URL is live at a
/// time and the accessors below are unambiguous.
pub fn mock_setup(url: &str) {
    MOCK_URLS.lock().unwrap().insert(url.to_string());
    MOCK_PENDING.lock().unwrap().remove(url);
    let stale: Vec<u64> = REGISTRY
        .lock()
        .unwrap()
        .keys()
        .filter(|(_, candidate)| candidate == url)
        .map(|(owner, _)| *owner)
        .collect();
    for owner in stale {
        drop_client(owner, url);
    }
}

/// Tear down the mock transport for `url`, so a later genuine connection to it
/// in the same process opens a real socket.
pub fn mock_teardown(url: &str) {
    MOCK_URLS.lock().unwrap().remove(url);
    MOCK_PENDING.lock().unwrap().remove(url);
    let owners: Vec<u64> = REGISTRY
        .lock()
        .unwrap()
        .keys()
        .filter(|(_, candidate)| candidate == url)
        .map(|(owner, _)| *owner)
        .collect();
    for owner in owners {
        drop_client(owner, url);
    }
}

fn mock_clients(url: &str) -> Vec<Arc<ClientState>> {
    REGISTRY
        .lock()
        .unwrap()
        .iter()
        .filter(|((_, candidate), _)| candidate == url)
        .map(|(_, c)| c.clone())
        .collect()
}
/// Feed a frame to the case's client, buffering it when the client does not
/// exist yet — the harness preloads the whole fixture before the first `watch*`
/// call creates the slot. `ensure_slot` drains the buffer on creation.
pub fn mock_inject(url: &str, msg: Value) {
    let clients = mock_clients(url);
    if clients.is_empty() {
        MOCK_PENDING
            .lock()
            .unwrap()
            .entry(url.to_string())
            .or_default()
            .push(msg);
        return;
    }
    for c in clients {
        c.mock_inject(msg.clone());
    }
}
pub fn mock_sent_messages(url: &str) -> Value {
    mock_clients(url)
        .last()
        .map(|c| c.mock_sent_value())
        .unwrap_or(Value::Array(vec![]))
}
pub fn mock_has_pending_futures(url: &str) -> bool {
    mock_clients(url).iter().any(|c| c.has_pending_futures())
}
pub fn mock_has_queued_messages(url: &str) -> bool {
    if MOCK_PENDING
        .lock()
        .unwrap()
        .get(url)
        .is_some_and(|p| !p.is_empty())
    {
        return true;
    }
    mock_clients(url).iter().any(|c| c.has_queued_messages())
}
pub fn mock_mark_completed(url: &str) {
    for c in mock_clients(url) {
        c.mark_ws_test_completed();
    }
}
pub fn mock_is_completed(url: &str) -> bool {
    let clients = mock_clients(url);
    // `all()` on an empty set is vacuously true, which would report "done"
    // between `mock_setup` evicting the previous case's client and the first
    // `watch*` creating this one's. No client means not started, not finished.
    !clients.is_empty() && clients.iter().all(|c| c.is_ws_test_completed())
}
pub fn mock_reject_futures(url: &str) {
    for c in mock_clients(url) {
        c.reject_pending_futures(Value::Str(
            "[ExchangeError] static ws test: the injected messages did not resolve the watch future".to_string()));
    }
}

/// Build the client-handle `Value` passed to `handle_message`: the URL plus
/// live snapshots of `subscriptions` / `futures` (the fields venues read via
/// `get_value(&client, "subscriptions")`).
pub fn client_value(owner_id: u64, url: &str) -> Value {
    // Pre-register the slot so subscriptions written on this handle (before the
    // socket connects) persist and read back — upbit-style subscribe building.
    let c = ensure_slot(owner_id, url);
    let mut m = indexmap::IndexMap::new();
    m.insert("url".to_string(), Value::Str(url.to_string()));
    m.insert("__ws_owner_id".to_string(), Value::Int(owner_id as i64));
    m.insert("subscriptions".to_string(), c.subscriptions_value());
    m.insert("futures".to_string(), c.futures_value());
    Value::Map(m)
}

fn owner_of(client: &Value) -> Option<u64> {
    match crate::get_value(client, &Value::Str("__ws_owner_id".to_string())) {
        Value::Int(id) if id >= 0 => Some(id as u64),
        _ => None,
    }
}

/// Extract the `url` from a client-handle `Value` (`Map{"url": ...}`).
pub fn url_of(client: &Value) -> Option<String> {
    match crate::get_value(client, &Value::Str("url".to_string())) {
        Value::Str(s) => Some(s),
        _ => None,
    }
}

fn hash_str(v: &Value) -> Option<String> {
    match v {
        Value::Str(s) => Some(s.clone()),
        _ => None,
    }
}

/// `client.resolve(value, messageHash)` routed by URL. Returns `value`.
pub fn value_resolve(client: &Value, args: &[Value]) -> Value {
    let value = args.get(0).cloned().unwrap_or(Value::Null);
    // `client.futures[hash].resolve(value)` — the future handle carries its own
    // hash, so there is no second arg. Resolve that hash.
    if let Some(hash) = future_hash_of(client) {
        if let (Some(owner), Some(url)) = (owner_of(client), url_of(client)) {
            if let Some(c) = get_client(owner, &url) {
                c.resolve(&hash, value.clone());
            }
        }
        return value;
    }
    if let (Some(owner), Some(url), Some(hash)) = (
        owner_of(client),
        url_of(client),
        args.get(1).and_then(hash_str),
    ) {
        if let Some(c) = get_client(owner, &url) {
            c.resolve(&hash, value.clone());
        }
    }
    value
}

/// Extract the hash a future handle (`client.futures[hash]`) resolves/rejects.
fn future_hash_of(client: &Value) -> Option<String> {
    match crate::get_value(client, &Value::Str("__ws_future_hash".to_string())) {
        Value::Str(s) => Some(s),
        _ => None,
    }
}

/// `client.reject(error, messageHash)` routed by URL.
pub fn value_reject(client: &Value, args: &[Value]) -> Value {
    let err = args.get(0).cloned().unwrap_or(Value::Null);
    // `client.futures[hash].reject(error)` — future handle carries its own hash.
    if let Some(hash) = future_hash_of(client) {
        if let (Some(owner), Some(url)) = (owner_of(client), url_of(client)) {
            if let Some(c) = get_client(owner, &url) {
                c.reject(&hash, err.clone());
            }
        }
        return err;
    }
    if let (Some(owner), Some(url)) = (owner_of(client), url_of(client)) {
        if let Some(c) = get_client(owner, &url) {
            match args.get(1).and_then(hash_str) {
                Some(hash) => c.reject(&hash, err.clone()),
                // reject with no hash → reject every pending future.
                None => {
                    let hashes: Vec<String> = c.futures.lock().unwrap().iter().cloned().collect();
                    for h in hashes {
                        c.reject(&h, err.clone());
                    }
                }
            }
        }
    }
    err
}

/// `client.send(message)` routed by URL. Serialises non-string payloads to JSON.
pub fn value_send(client: &Value, args: &[Value]) -> Value {
    if let (Some(owner), Some(url)) = (owner_of(client), url_of(client)) {
        if let Some(c) = get_client(owner, &url) {
            let payload = match args.get(0) {
                Some(Value::Str(s)) => s.clone(),
                Some(v) => v.to_json().to_string(),
                None => String::new(),
            };
            c.send_text(payload);
        }
    }
    Value::Null
}

/// `client.reset(...)` routed by URL.
pub fn value_reset(client: &Value) -> Value {
    if let (Some(owner), Some(url)) = (owner_of(client), url_of(client)) {
        if let Some(c) = get_client(owner, &url) {
            c.reset();
        }
    }
    Value::Null
}

/// `client.on_pong(...)` routed by URL.
pub fn value_on_pong(client: &Value) -> Value {
    if let (Some(owner), Some(url)) = (owner_of(client), url_of(client)) {
        if let Some(c) = get_client(owner, &url) {
            c.on_pong();
        }
    }
    Value::Null
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio_tungstenite::tungstenite::Message as WsMessage;

    // A minimal mock exchange WS server: accepts one connection, waits for a
    // subscribe frame, then streams a few JSON "ticker" messages. Proves the
    // full connect → send(subscribe) → receive → parse → resolve round-trip
    // without touching a live venue.
    async fn spawn_mock_server() -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            if let Ok((stream, _)) = listener.accept().await {
                let mut ws = tokio_tungstenite::accept_async(stream).await.unwrap();
                // Wait for the client's subscribe frame.
                if let Some(Ok(WsMessage::Text(sub))) = ws.next().await {
                    assert!(sub.contains("subscribe"), "expected subscribe, got {sub}");
                }
                // Stream three ticker updates.
                for px in ["100.5", "101.0", "101.5"] {
                    let msg = format!(
                        "{{\"channel\":\"ticker\",\"symbol\":\"BTC/USDT\",\"last\":\"{px}\"}}"
                    );
                    ws.send(WsMessage::Text(msg)).await.unwrap();
                }
                // Give the client time to drain before closing.
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                let _ = ws.close(None).await;
            }
        });
        format!("ws://{addr}")
    }

    async fn spawn_reconnect_server() -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (first_stream, _) = listener.accept().await.unwrap();
            let mut first = tokio_tungstenite::accept_async(first_stream).await.unwrap();
            assert!(
                matches!(first.next().await, Some(Ok(WsMessage::Text(ref s))) if s.contains("subscribe"))
            );
            first.close(None).await.unwrap();
            let (second_stream, _) = listener.accept().await.unwrap();
            let mut second = tokio_tungstenite::accept_async(second_stream)
                .await
                .unwrap();
            assert!(
                matches!(second.next().await, Some(Ok(WsMessage::Text(ref s))) if s.contains("subscribe"))
            );
            second
                .send(WsMessage::Text("{\"reconnected\":true}".to_string()))
                .await
                .unwrap();
        });
        format!("ws://{addr}")
    }

    #[tokio::test]
    async fn transport_roundtrip() {
        let url = spawn_mock_server().await;
        // Distinct, high owner ids: `Internals` hands out ws_owner_id from 1 up, and
        // dropping an Exchange now closes its clients — a test that squatted on a
        // low id would have its socket closed by an unrelated exchange going away.
        let owner = 9101;
        let client = ensure_client(owner, &url).await.expect("connect");

        // Send a subscribe frame once (idempotent per hash).
        assert!(client.subscribe_once("ticker:BTC/USDT", Value::Null));
        assert!(!client.subscribe_once("ticker:BTC/USDT", Value::Null));
        assert!(client.send_text("{\"op\":\"subscribe\",\"channel\":\"ticker\"}".to_string()));

        // Drive: pull each inbound message, mimic handle_message resolving the
        // "ticker" hash, and collect the resolved values.
        let mut lasts = Vec::new();
        while lasts.len() < 3 {
            let msg = client.next_message().await.expect("message before close");
            let last = crate::get_value(&msg, &Value::Str("last".to_string()));
            if let Value::Str(s) = &last {
                client.note_futures(&["ticker".to_string()]);
                client.resolve("ticker", Value::Str(s.clone()));
            }
            if let Some(Ok(Value::Str(v))) = client.take_settled(&["ticker".to_string()]) {
                lasts.push(v);
            }
        }
        assert_eq!(lasts, vec!["100.5", "101.0", "101.5"]);

        // Field snapshots the transpiled code reads off the client handle.
        let subs = client.subscriptions_value();
        assert!(crate::runtime::is_true(&crate::get_value(
            &subs,
            &Value::Str("ticker:BTC/USDT".to_string())
        )));

        drop_client(owner, &url);
    }

    #[tokio::test]
    async fn preconnect_send_is_queued_until_socket_connects() {
        let url = spawn_mock_server().await;
        let owner = 9102;
        let client = ensure_slot(owner, &url);
        assert!(client.send_text("{\"op\":\"subscribe\"}".to_string()));
        ensure_client(owner, &url).await.unwrap();
        let message =
            tokio::time::timeout(std::time::Duration::from_secs(2), client.next_message())
                .await
                .unwrap()
                .unwrap();
        assert_eq!(
            crate::get_value(&message, &Value::Str("last".to_string())),
            Value::Str("100.5".to_string())
        );
        drop_client(owner, &url);
    }

    // A minimal Core whose `handle_message` resolves the "ticker" hash with the
    // inbound message's `last` field — exactly what a real venue's
    // handle_message does. Lets us drive the *actual* `watch()` runtime end to
    // end (connect → subscribe → frame → dispatch_to_derived("handle_message")
    // → resolve → return) against the mock server, independent of venue quirks.
    struct TestWsCore {
        exchange: crate::exchange::Exchange,
    }
    impl std::ops::Deref for TestWsCore {
        type Target = crate::exchange::Exchange;
        fn deref(&self) -> &Self::Target {
            &self.exchange
        }
    }
    impl std::ops::DerefMut for TestWsCore {
        fn deref_mut(&mut self) -> &mut Self::Target {
            &mut self.exchange
        }
    }
    impl crate::exchange::DerivedExchange for TestWsCore {}
    impl crate::exchange_generated::ExchangeBase for TestWsCore {
        fn call_dynamic<'a>(
            &'a mut self,
            method: &'a str,
            args: Vec<Value>,
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Value> + Send + 'a>> {
            Box::pin(async move {
                match method {
                    "handle_message" => {
                        let client = args.get(0).cloned().unwrap_or(Value::Null);
                        let message = args.get(1).cloned().unwrap_or(Value::Null);
                        let last = crate::get_value(&message, &Value::Str("last".to_string()));
                        // `client.resolve(value, messageHash)` — routes to the registry.
                        client.resolve(&[last, Value::Str("ticker".to_string())]);
                        Value::Null
                    }
                    _ => self.call_dynamic_base(method, args).await,
                }
            })
        }
    }

    #[tokio::test]
    async fn watch_drive_loop_end_to_end() {
        use crate::exchange::ExchangeRuntime;
        let url = spawn_mock_server().await;
        let mut core = TestWsCore {
            exchange: crate::exchange::Exchange::new(None),
        };
        // Drive the real base `watch()`: connect, send subscribe, read frames,
        // dispatch each to handle_message, return once "ticker" resolves.
        let result = ExchangeRuntime::watch(
            &mut core,
            Value::Str(url.clone()),
            Value::Str("ticker".to_string()),
            &[
                Value::Str("{\"op\":\"subscribe\",\"channel\":\"ticker\"}".to_string()),
                Value::Str("ticker".to_string()),
                Value::Null,
            ],
        )
        .await;
        // First streamed ticker.
        assert_eq!(result, Value::Str("100.5".to_string()));
        drop_client(core.exchange.internals.ws_owner_id, &url);
    }

    #[tokio::test]
    async fn reconnect_replays_subscription_frames() {
        let url = spawn_reconnect_server().await;
        let owner = 9808;
        let client = ensure_client(owner, &url).await.unwrap();
        let hashes = vec!["ticker".to_string()];
        let payload = "{\"op\":\"subscribe\"}".to_string();
        client.remember_subscribe_message(&hashes, payload.clone());
        assert!(client.send_text(payload));
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while client.next_message().await.is_some() {}
        })
        .await
        .unwrap();
        ensure_client(owner, &url).await.unwrap();
        let message =
            tokio::time::timeout(std::time::Duration::from_secs(2), client.next_message())
                .await
                .unwrap()
                .unwrap();
        assert_eq!(
            crate::get_value(&message, &Value::Str("reconnected".to_string())),
            Value::Bool(true)
        );
        drop_client(owner, &url);
    }

    #[test]
    fn registry_is_isolated_by_exchange_owner() {
        let first = ensure_slot(9201, "wss://same.example");
        let second = ensure_slot(9202, "wss://same.example");
        assert!(!Arc::ptr_eq(&first, &second));
        first.set_subscription("private", Value::Bool(true));
        assert!(!second.is_subscribed("private"));
        drop_client(9201, "wss://same.example");
        assert!(get_client(9202, "wss://same.example").is_some());
        drop_client(9202, "wss://same.example");
    }

    #[test]
    fn settled_future_is_removed() {
        let client = ensure_slot(9303, "wss://cleanup.example");
        client.note_futures(&["ticker".to_string()]);
        client.resolve("ticker", Value::Int(1));
        assert!(!client.has_pending_futures());
        assert_eq!(
            client.take_settled(&["ticker".to_string()]),
            Some(Ok(Value::Int(1)))
        );
        drop_client(9303, "wss://cleanup.example");
    }

    #[test]
    fn queues_are_bounded_and_overflow_rejects_waiters() {
        let client = ensure_slot(9404, "wss://bounded.example");
        *client.connected.lock().unwrap() = true;
        let (tx, _rx) = mpsc::channel(OUTGOING_CAPACITY);
        *client.outgoing.lock().unwrap() = tx;
        client.note_futures(&["send".to_string()]);
        for n in 0..OUTGOING_CAPACITY {
            assert!(client.send_text(n.to_string()));
        }
        assert!(!client.send_text("overflow".to_string()));
        assert!(matches!(client.take_settled(&["send".to_string()]),
            Some(Err(Value::Str(ref e))) if e.contains("outgoing queue capacity exceeded")));
        client.note_futures(&["book".to_string()]);
        for n in 0..INCOMING_CAPACITY {
            client.push_incoming(Value::Int(n as i64));
        }
        client.push_incoming(Value::Int(-1));
        let error = client.take_settled(&["book".to_string()]);
        assert!(matches!(error, Some(Err(Value::Str(ref e))) if e.contains("capacity exceeded")));
        drop_client(9404, "wss://bounded.example");
    }

    #[test]
    fn missed_pong_rejects_pending_future_as_request_timeout() {
        let client = ensure_slot(9505, "wss://pong.example");
        client.note_futures(&["ticker".to_string()]);
        *client.last_pong_ms.lock().unwrap() = 1;
        assert!(client.pong_timed_out(61_002, 30_000));
        client.fail_transport(Value::Str("[RequestTimeout] missed pong".to_string()));
        assert!(matches!(client.take_settled(&["ticker".to_string()]),
            Some(Err(Value::Str(ref e))) if e.starts_with("[RequestTimeout]")));
        drop_client(9505, "wss://pong.example");
    }

    #[test]
    fn explicit_close_rejects_only_owners_pending_futures() {
        let first = ensure_slot(9606, "wss://close.example");
        let second = ensure_slot(9707, "wss://close.example");
        first.note_futures(&["orders".to_string()]);
        second.note_futures(&["orders".to_string()]);
        drop_client(9606, "wss://close.example");
        assert!(matches!(first.take_settled(&["orders".to_string()]),
            Some(Err(Value::Str(ref e))) if e.starts_with("[ExchangeClosedByUser]")));
        assert!(second.has_pending_futures());
        drop_client(9707, "wss://close.example");
    }

    #[tokio::test]
    async fn parse_helpers() {
        // JSON text → dict; non-JSON → Value::Str.
        assert!(matches!(parse_text("{\"a\":1}"), Value::Dict(_)));
        assert_eq!(parse_text("pong"), Value::Str("pong".to_string()));
        // gzip binary → parsed JSON.
        use std::io::Write;
        let mut e = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        e.write_all(b"{\"x\":true}").unwrap();
        let gz = e.finish().unwrap();
        assert!(matches!(parse_binary(&gz), Value::Dict(_)));
    }

    // ── regressions ─────────────────────────────────────────────────────────

    #[test]
    fn mock_setup_delivers_frames_preloaded_before_the_client_exists() {
        // The static-WS harness preloads the whole fixture BEFORE the first
        // watch* call creates the (owner_id, url) slot, and being URL-keyed it
        // cannot name that slot. Frames must be buffered, not dropped.
        let url = "wss://preload.example";
        mock_setup(url);
        mock_inject(url, Value::Int(1));
        mock_inject(url, Value::Int(2));
        let client = ensure_slot(9910, url);
        assert!(client.is_mock(), "the armed URL must produce a mock client");
        assert!(
            client.has_queued_messages(),
            "frames injected before the slot existed were dropped"
        );
        assert_eq!(client.incoming.lock().unwrap().len(), 2);
        mock_teardown(url);
    }

    #[test]
    fn mock_setup_evicts_the_previous_cases_client() {
        // One client per URL at a time, so the URL-keyed accessors are not at
        // the mercy of REGISTRY iteration order.
        let url = "wss://percase.example";
        mock_setup(url);
        let first = ensure_slot(9911, url);
        first.send_text("first-case".to_string());
        mock_setup(url);
        assert!(first.is_closed(), "the previous case's client must be evicted");
        assert_eq!(mock_clients(url).len(), 0);
        let second = ensure_slot(9912, url);
        second.send_text("second-case".to_string());
        assert_eq!(mock_clients(url).len(), 1);
        assert_eq!(
            mock_sent_messages(url),
            Value::Array(vec![Value::Str("second-case".to_string())])
        );
        mock_teardown(url);
    }

    #[test]
    fn mock_arm_is_consumed_and_does_not_mock_a_later_real_client() {
        let url = "wss://armonce.example";
        mock_setup(url);
        let mocked = ensure_slot(9913, url);
        assert!(mocked.is_mock());
        drop_client(9913, url);
        // A genuine connection to the same URL later in the process must not
        // silently inherit the fixture's mock transport.
        let real = ensure_slot(9914, url);
        assert!(!real.is_mock(), "the mock arm leaked to a real client");
        drop_client(9914, url);
    }

    #[test]
    fn superseded_keep_alive_cannot_fail_the_next_connection() {
        // A keep-alive task from a dead socket used to see `connected == true`
        // again after a reconnect and fail the healthy connection that
        // replaced it. It must stand down on generation instead.
        let client = ensure_slot(9915, "wss://generation.example");
        let stale_gen = client.bump_generation(); // "connection 1"
        *client.connected.lock().unwrap() = true;
        client.bump_generation(); // reconnect installs "connection 2"
        assert_ne!(
            client.generation(),
            stale_gen,
            "the stale task must observe a moved generation while connected"
        );
        client.note_futures(&["ticker".to_string()]);
        assert!(
            client.take_settled(&["ticker".to_string()]).is_none(),
            "no stale task ran, so nothing may be settled"
        );
        drop_client(9915, "wss://generation.example");
    }

    #[test]
    fn fail_transport_retires_the_generation_so_the_old_reader_stops() {
        // The socket behind a failed transport may still be open; its reader
        // must not keep feeding `incoming` alongside the replacement's.
        let client = ensure_slot(9916, "wss://dupreader.example");
        *client.connected.lock().unwrap() = true;
        let live = client.bump_generation();
        client.fail_transport(Value::Str("[NetworkError] boom".to_string()));
        assert_ne!(client.generation(), live);
        drop_client(9916, "wss://dupreader.example");
    }

    #[test]
    fn settling_one_hash_retires_its_siblings() {
        // watch_multiple registers a race; the losers must not linger in
        // `futures`, or a later blanket reject records an error under a hash
        // nobody awaits and hands it to an unrelated watch.
        let client = ensure_slot(9917, "wss://siblings.example");
        let hashes = vec!["a".to_string(), "b".to_string()];
        client.note_futures(&hashes);
        client.resolve("a", Value::Int(1));
        assert_eq!(client.take_settled(&hashes), Some(Ok(Value::Int(1))));
        assert!(
            !client.has_pending_futures(),
            "the losing hash was left pending"
        );
        // A blanket reject now has nothing to record, so a later watch on "b"
        // starts clean instead of inheriting a stale error.
        client.reject_pending_futures(Value::Str("[NetworkError] later".to_string()));
        client.note_futures(&["b".to_string()]);
        assert_eq!(client.take_settled(&["b".to_string()]), None);
        drop_client(9917, "wss://siblings.example");
    }

    #[test]
    fn subscription_replay_preserves_send_order() {
        let client = ensure_slot(9918, "wss://replayorder.example");
        for (hash, payload) in [("auth", "1-auth"), ("book", "2-book"), ("trades", "3-trades")] {
            client.remember_subscribe_message(&[hash.to_string()], payload.to_string());
        }
        let replayed: Vec<String> = client
            .subscribe_messages
            .lock()
            .unwrap()
            .values()
            .cloned()
            .collect();
        assert_eq!(replayed, vec!["1-auth", "2-book", "3-trades"]);
        drop_client(9918, "wss://replayorder.example");
    }

    #[test]
    fn non_owning_poll_leaves_the_ancestors_registration_intact() {
        // A nested watch on a url an ancestor loop is already driving polls the
        // client and returns immediately. It must not retire hashes the ancestor
        // registered, or the ancestor's later resolve is silently dropped.
        let client = ensure_slot(9919, "wss://nested.example");
        let outer = vec!["a".to_string(), "b".to_string()];
        let nested = vec!["b".to_string(), "c".to_string()];
        client.note_futures(&outer);
        client.note_futures(&nested);
        client.resolve("c", Value::Int(7));
        // The nested poll takes its own value...
        assert_eq!(
            client.take_settled_no_retire(&nested),
            Some(Ok(Value::Int(7)))
        );
        // ...without unregistering the ancestor's hashes.
        client.resolve("b", Value::Int(42));
        assert_eq!(client.take_settled(&outer), Some(Ok(Value::Int(42))));
        drop_client(9919, "wss://nested.example");
    }

    #[test]
    fn owning_settle_still_retires_losers() {
        // take_settled keeps retiring; only the no_retire variant opts out.
        let client = ensure_slot(9920, "wss://owning.example");
        let hashes = vec!["a".to_string(), "b".to_string()];
        client.note_futures(&hashes);
        client.resolve("a", Value::Int(1));
        assert_eq!(client.take_settled(&hashes), Some(Ok(Value::Int(1))));
        assert!(!client.has_pending_futures());
        drop_client(9920, "wss://owning.example");
    }

    #[tokio::test]
    async fn value_delivered_before_close_is_returned_not_reported_as_a_close() {
        // `take_settled` consumes the entry, so the drive loop's is_closed guard
        // must RETURN a value it finds rather than drop it and panic with
        // ExchangeClosedByUser. Race a resolve + close against a live loop.
        use crate::exchange::ExchangeRuntime;
        let url = "wss://closerace.example";
        mock_setup(url);
        let mut core = TestWsCore {
            exchange: crate::exchange::Exchange::new(None),
        };
        let owner = core.exchange.internals.ws_owner_id;
        // Pre-create the slot so we hold the very Arc the drive loop will drive.
        let client = ensure_slot(owner, url);
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            // A value lands, then the client is closed before the loop reads it.
            client.resolve("ticker", Value::Str("99.5".to_string()));
            drop_client(owner, url);
        });
        let args = [
            Value::Str("{\"op\":\"subscribe\"}".to_string()),
            Value::Str("ticker".to_string()),
            Value::Null,
        ];
        let watch = ExchangeRuntime::watch(
            &mut core,
            Value::Str(url.to_string()),
            Value::Str("ticker".to_string()),
            &args,
        );
        let outcome = tokio::time::timeout(
            std::time::Duration::from_secs(20),
            futures::FutureExt::catch_unwind(std::panic::AssertUnwindSafe(watch)),
        )
        .await;
        match outcome {
            Err(_) => panic!("watch hung"),
            Ok(Err(_)) => panic!("the value delivered before the close was discarded"),
            Ok(Ok(v)) => assert_eq!(v, Value::Str("99.5".to_string())),
        }
        mock_teardown(url);
    }

    #[tokio::test]
    async fn exhausted_mock_fixture_fails_instead_of_spinning() {
        // A mock client is permanently "connected", so `ensure_client` always
        // succeeds for it. The drive loop must not treat an exhausted fixture as
        // a transport drop and reconnect-spin on it — the harness needs a
        // failure it can report.
        use crate::exchange::ExchangeRuntime;
        let url = "wss://exhausted.example";
        mock_setup(url);
        let mut core = TestWsCore {
            exchange: crate::exchange::Exchange::new(None),
        };
        let args = [
            Value::Str("{\"op\":\"subscribe\"}".to_string()),
            Value::Str("ticker".to_string()),
            Value::Null,
        ];
        let watch = ExchangeRuntime::watch(
            &mut core,
            Value::Str(url.to_string()),
            Value::Str("ticker".to_string()),
            &args,
        );
        let outcome = tokio::time::timeout(
            std::time::Duration::from_secs(20),
            futures::FutureExt::catch_unwind(std::panic::AssertUnwindSafe(watch)),
        )
        .await;
        match outcome {
            Err(_) => panic!("the drive loop spun on an exhausted fixture instead of failing"),
            Ok(Ok(v)) => panic!("expected a failure, resolved with {v:?}"),
            Ok(Err(_)) => {}
        }
        mock_teardown(url);
    }

    #[tokio::test]
    async fn dropping_an_exchange_releases_its_websocket_clients() {
        // The registry is process-global and keyed per instance, so without a
        // Drop the sockets and tasks of every dropped exchange would be
        // stranded there for the life of the process.
        let url = "wss://lifecycle.example";
        let owner = {
            let exchange = crate::exchange::Exchange::new(None);
            let owner = exchange.internals.ws_owner_id;
            ensure_slot(owner, url);
            assert!(get_client(owner, url).is_some());
            owner
        };
        assert!(
            get_client(owner, url).is_none(),
            "the dropped exchange left its client in the registry"
        );
    }
}
