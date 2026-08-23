//! Bindings for Lighter's prebuilt signer library.
//!
//! Lighter's signing (Poseidon hashes over a zk-friendly curve) is not
//! reimplemented here, and it is not reimplemented in any other CCXT target
//! either: Go links `github.com/elliottech/lighter-go` directly, and Python,
//! PHP and C# all bind the prebuilt shared library that Lighter ships from that
//! same Go source (JS loads the WASM build of it). This module does the Rust
//! equivalent over the library's C ABI, so `options["libraryPath"]` behaves the
//! way it already does on the other targets.
//!
//! The ABI is the one declared in the vendored header next to the binaries
//! (`ts/src/test/static/binaries/lighter-signer-*.h`). Two details worth
//! recording because they are easy to get wrong:
//!
//!   * `CreateClient` returns `char*`, not a struct — a null (or empty) pointer
//!     means success and anything else is the error text.
//!   * `SignedTxResponse` carries five fields; `messageToSign` sits between
//!     `txHash` and `err`, and the L1-signed flows (`SignApproveIntegrator`,
//!     `SignChangePubKey`) read it.

use crate::Value;
use libloading::{Library, Symbol};
use once_cell::sync::Lazy;
use std::collections::HashMap;
use std::ffi::{c_char, c_int, c_longlong, CStr, CString};
use std::sync::{Arc, Mutex};

// ─── C ABI ──────────────────────────────────────────────────────────────────

#[repr(C)]
struct SignedTxResponse {
    tx_type: u8,
    tx_info: *mut c_char,
    tx_hash: *mut c_char,
    message_to_sign: *mut c_char,
    err: *mut c_char,
}

#[repr(C)]
struct StrOrErr {
    str_: *mut c_char,
    err: *mut c_char,
}

#[repr(C)]
struct ApiKeyResponse {
    private_key: *mut c_char,
    public_key: *mut c_char,
    err: *mut c_char,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct CreateOrderTxReq {
    market_index: i16,
    client_order_index: i64,
    base_amount: i64,
    price: u32,
    is_ask: u8,
    type_: u8,
    time_in_force: u8,
    reduce_only: u8,
    trigger_price: u32,
    order_expiry: i64,
}

/// CCXT always supplies its own nonce (see `fetchNonce`), so every call runs
/// the library in skip-nonce mode, exactly as the other targets do.
const SKIP_NONCE: u8 = 1;

// ─── loaded library registry ────────────────────────────────────────────────
//
// `Symbol` borrows its `Library`, so the library has to outlive every call. We
// keep one `Arc<Library>` per path for the process lifetime and hand callers a
// `Value::Str(path)` handle, which is what `loadLighterLibrary` returns and
// what every `lighterSign*` call passes back in.

static LIBS: Lazy<Mutex<HashMap<String, Arc<Library>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// Last successfully loaded path, used when a caller passes a signer handle we
/// cannot read — `lighterCreateClient` is invoked with an empty signer from
/// inside `loadLighterLibrary` on every target.
static LAST_PATH: Lazy<Mutex<Option<String>>> = Lazy::new(|| Mutex::new(None));

fn load(path: &str) -> Result<Arc<Library>, String> {
    let mut guard = LIBS.lock().unwrap();
    if let Some(lib) = guard.get(path) {
        return Ok(Arc::clone(lib));
    }
    if !std::path::Path::new(path).is_file() {
        return Err(format!("the library path does not exist: {path}"));
    }
    // SAFETY: dlopen of a caller-supplied path. Same trust model as the ctypes /
    // FFI loads on the python, php and c# targets.
    let lib = unsafe { Library::new(path) }.map_err(|e| format!("could not load {path}: {e}"))?;
    let lib = Arc::new(lib);
    guard.insert(path.to_string(), Arc::clone(&lib));
    *LAST_PATH.lock().unwrap() = Some(path.to_string());
    Ok(lib)
}

/// Resolve the library behind a signer handle, falling back to the most
/// recently loaded one — `lighterCreateClient` is reached with an empty signer
/// from inside `changeApiKey`, on every target.
fn resolve(signer: &Value) -> Result<Arc<Library>, String> {
    let handle = match signer {
        Value::Dict(_) => crate::get_value(signer, &Value::Str(HANDLE_KEY.to_string())),
        other => other.clone(),
    };
    if let Value::Str(p) = &handle {
        if !p.is_empty() {
            return load(p);
        }
    }
    let last = LAST_PATH.lock().unwrap().clone();
    match last {
        Some(p) => load(&p),
        None => Err("no lighter signer library has been loaded; \
                     set options[\"libraryPath\"] to the signer for your platform"
            .to_string()),
    }
}

// ─── helpers ────────────────────────────────────────────────────────────────

/// Copy a returned string out and hand the buffer back. Go allocated it with
/// `C.CString`, so it has to go through the library's own `Free` — that is what
/// python's `decode_and_free` does for every field of every response, and
/// skipping it leaks a few hundred bytes per signature.
unsafe fn take(lib: &Library, p: *mut c_char) -> Option<String> {
    if p.is_null() {
        return None;
    }
    let s = CStr::from_ptr(p).to_string_lossy().into_owned();
    if let Ok(free) = lib.get::<unsafe extern "C" fn(*mut c_char)>(b"Free\0") {
        free(p);
    }
    if s.is_empty() { None } else { Some(s) }
}

fn field(request: &Value, key: &str) -> Value {
    crate::get_value(request, &Value::Str(key.to_string()))
}

pub fn as_i64(v: &Value) -> i64 {
    match v {
        Value::Int(n) => *n,
        Value::Float(f) => *f as i64,
        Value::Bool(b) => *b as i64,
        Value::Str(s) => s.parse::<i64>().unwrap_or_else(|_| s.parse::<f64>().unwrap_or(0.0) as i64),
        _ => 0,
    }
}

fn num(request: &Value, key: &str) -> i64 {
    as_i64(&field(request, key))
}

fn text(request: &Value, key: &str) -> String {
    match field(request, key) {
        Value::Str(s) => s,
        Value::Int(n) => n.to_string(),
        Value::Float(f) => f.to_string(),
        _ => String::new(),
    }
}

fn fail(what: &str, msg: String) -> ! {
    panic!(
        "{}",
        crate::exchange_errors::not_supported(Value::Str(format!("lighter {what}(): {msg}")))
    );
}

/// `[txType, txInfo]`, the shape every `lighterSign*` returns on the other targets.
/// Every field is drained even when unused, because each one is a separate
/// allocation the library expects back.
unsafe fn signed(lib: &Library, what: &str, r: SignedTxResponse) -> Value {
    let info = take(lib, r.tx_info);
    let _ = take(lib, r.tx_hash);
    let _ = take(lib, r.message_to_sign);
    if let Some(e) = take(lib, r.err) {
        fail(what, e);
    }
    Value::array(vec![
        Value::Int(r.tx_type as i64),
        Value::Str(info.unwrap_or_default()),
    ])
}

/// `[txType, txInfo, messageToSign]` for the flows that then sign with the L1 key.
unsafe fn signed_with_message(lib: &Library, what: &str, r: SignedTxResponse) -> Value {
    let info = take(lib, r.tx_info);
    let message = take(lib, r.message_to_sign);
    let _ = take(lib, r.tx_hash);
    if let Some(e) = take(lib, r.err) {
        fail(what, e);
    }
    Value::array(vec![
        Value::Int(r.tx_type as i64),
        Value::Str(info.unwrap_or_default()),
        Value::Str(message.unwrap_or_default()),
    ])
}

macro_rules! sym {
    ($lib:expr, $what:expr, $name:literal, $ty:ty) => {{
        let s: Symbol<$ty> = match $lib.get($name) {
            Ok(s) => s,
            Err(e) => fail($what, format!("{} missing from the signer library: {e}",
                                          String::from_utf8_lossy(&$name[..$name.len() - 1]))),
        };
        s
    }};
}

// ─── entry points ───────────────────────────────────────────────────────────

/// The key the signer handle carries its library path under.
const HANDLE_KEY: &str = "libraryPath";

pub fn load_library(path: &str) -> Value {
    match load(path) {
        Ok(_) => {
            let mut handle = crate::value::HashMap::new();
            handle.insert(HANDLE_KEY.to_string(), Value::Str(path.to_string()));
            Value::map(handle)
        }
        Err(e) => fail("loadLighterLibrary", e),
    }
}

/// The url the other targets hand the library: `urls.api.public` with
/// `{hostname}` substituted. Lighter declares it as `https://mainnet.{hostname}`
/// (and `https://testnet.{hostname}` in sandbox), so the substitution is not
/// optional — and forks that only swap urls, like the robinhood chain, are
/// carried along by reading it out of the instance rather than hardcoding.
pub fn client_url(urls: &Value, hostname: &Value) -> String {
    let public = crate::get_value(
        &crate::get_value(urls, &Value::Str("api".to_string())),
        &Value::Str("public".to_string()),
    );
    let host = match hostname {
        Value::Str(h) => h.as_str(),
        _ => "",
    };
    match &public {
        Value::Str(u) => u.replace("{hostname}", host),
        _ => String::new(),
    }
}

pub fn create_client(
    signer: &Value,
    url: &str,
    private_key: &str,
    chain_id: i64,
    api_key_index: i64,
    account_index: i64,
) -> Value {
    let lib = resolve(signer).unwrap_or_else(|e| fail("lighterCreateClient", e));
    let url_c = CString::new(url).unwrap_or_default();
    let pk_c = CString::new(private_key).unwrap_or_default();
    unsafe {
        let f = sym!(lib, "lighterCreateClient", b"CreateClient\0",
            unsafe extern "C" fn(*const c_char, *const c_char, c_int, c_int, c_longlong) -> *mut c_char);
        // char*, not a struct: null / empty means success
        if let Some(e) = take(&lib, f(url_c.as_ptr(), pk_c.as_ptr(), chain_id as c_int,
                                api_key_index as c_int, account_index as c_longlong)) {
            fail("lighterCreateClient", format!("failed to create lighter client: {e}"));
        }
    }
    signer.clone()
}

pub fn generate_api_key(signer: &Value) -> Value {
    let lib = resolve(signer).unwrap_or_else(|e| fail("lighterGenerateApiKey", e));
    unsafe {
        let f = sym!(lib, "lighterGenerateApiKey", b"GenerateAPIKey\0",
            unsafe extern "C" fn() -> ApiKeyResponse);
        let r = f();
        if let Some(e) = take(&lib, r.err) {
            fail("lighterGenerateApiKey", e);
        }
        Value::array(vec![
            Value::Str(take(&lib, r.private_key).unwrap_or_default()),
            Value::Str(take(&lib, r.public_key).unwrap_or_default()),
        ])
    }
}

pub fn create_auth_token(signer: &Value, request: &Value) -> Value {
    let lib = resolve(signer).unwrap_or_else(|e| fail("lighterCreateAuthToken", e));
    unsafe {
        let f = sym!(lib, "lighterCreateAuthToken", b"CreateAuthToken\0",
            unsafe extern "C" fn(c_longlong, c_int, c_longlong) -> StrOrErr);
        let r = f(num(request, "deadline") as c_longlong,
                  num(request, "api_key_index") as c_int,
                  num(request, "account_index") as c_longlong);
        if let Some(e) = take(&lib, r.err) {
            fail("lighterCreateAuthToken", e);
        }
        Value::Str(take(&lib, r.str_).unwrap_or_default())
    }
}

pub fn sign_create_order(signer: &Value, request: &Value) -> Value {
    let lib = resolve(signer).unwrap_or_else(|e| fail("lighterSignCreateOrder", e));
    unsafe {
        let f = sym!(lib, "lighterSignCreateOrder", b"SignCreateOrder\0",
            unsafe extern "C" fn(c_int, c_longlong, c_longlong, c_int, c_int, c_int, c_int, c_int,
                                 c_int, c_longlong, c_longlong, c_int, c_int, u8, c_longlong,
                                 c_int, c_longlong) -> SignedTxResponse);
        signed(&lib, "lighterSignCreateOrder", f(
            num(request, "market_index") as c_int,
            num(request, "client_order_index") as c_longlong,
            num(request, "base_amount") as c_longlong,
            num(request, "avg_execution_price") as c_int,
            num(request, "is_ask") as c_int,
            num(request, "order_type") as c_int,
            num(request, "time_in_force") as c_int,
            num(request, "reduce_only") as c_int,
            num(request, "trigger_price") as c_int,
            num(request, "order_expiry") as c_longlong,
            num(request, "integrator_account_index") as c_longlong,
            num(request, "integrator_taker_fee") as c_int,
            num(request, "integrator_maker_fee") as c_int,
            SKIP_NONCE,
            num(request, "nonce") as c_longlong,
            num(request, "api_key_index") as c_int,
            num(request, "account_index") as c_longlong,
        ))
    }
}

pub fn sign_create_grouped_orders(signer: &Value, request: &Value) -> Value {
    let lib = resolve(signer).unwrap_or_else(|e| fail("lighterSignCreateGroupedOrders", e));
    let orders_v = field(request, "orders");
    let rows: Vec<Value> = match &orders_v {
        Value::Arr(a) => a.as_ref().clone(),
        _ => Vec::new(),
    };
    let orders: Vec<CreateOrderTxReq> = rows
        .iter()
        .map(|o| CreateOrderTxReq {
            market_index: num(o, "market_index") as i16,
            client_order_index: num(o, "client_order_index"),
            base_amount: num(o, "base_amount"),
            price: num(o, "avg_execution_price") as u32,
            is_ask: num(o, "is_ask") as u8,
            type_: num(o, "order_type") as u8,
            time_in_force: num(o, "time_in_force") as u8,
            reduce_only: num(o, "reduce_only") as u8,
            trigger_price: num(o, "trigger_price") as u32,
            order_expiry: num(o, "order_expiry"),
        })
        .collect();
    unsafe {
        let f = sym!(lib, "lighterSignCreateGroupedOrders", b"SignCreateGroupedOrders\0",
            unsafe extern "C" fn(u8, *const CreateOrderTxReq, c_int, c_longlong, c_int, c_int,
                                 u8, c_longlong, c_int, c_longlong) -> SignedTxResponse);
        signed(&lib, "lighterSignCreateGroupedOrders", f(
            num(request, "grouping_type") as u8,
            orders.as_ptr(),
            orders.len() as c_int,
            num(request, "integrator_account_index") as c_longlong,
            num(request, "integrator_taker_fee") as c_int,
            num(request, "integrator_maker_fee") as c_int,
            SKIP_NONCE,
            num(request, "nonce") as c_longlong,
            num(request, "api_key_index") as c_int,
            num(request, "account_index") as c_longlong,
        ))
    }
}

pub fn sign_cancel_order(signer: &Value, request: &Value) -> Value {
    let lib = resolve(signer).unwrap_or_else(|e| fail("lighterSignCancelOrder", e));
    unsafe {
        let f = sym!(lib, "lighterSignCancelOrder", b"SignCancelOrder\0",
            unsafe extern "C" fn(c_int, c_longlong, u8, c_longlong, c_int, c_longlong) -> SignedTxResponse);
        signed(&lib, "lighterSignCancelOrder", f(
            num(request, "market_index") as c_int,
            num(request, "order_index") as c_longlong,
            SKIP_NONCE,
            num(request, "nonce") as c_longlong,
            num(request, "api_key_index") as c_int,
            num(request, "account_index") as c_longlong,
        ))
    }
}

pub fn sign_cancel_all_orders(signer: &Value, request: &Value) -> Value {
    let lib = resolve(signer).unwrap_or_else(|e| fail("lighterSignCancelAllOrders", e));
    unsafe {
        let f = sym!(lib, "lighterSignCancelAllOrders", b"SignCancelAllOrders\0",
            unsafe extern "C" fn(c_int, c_longlong, u8, c_longlong, c_int, c_longlong) -> SignedTxResponse);
        signed(&lib, "lighterSignCancelAllOrders", f(
            num(request, "time_in_force") as c_int,
            num(request, "time") as c_longlong,
            SKIP_NONCE,
            num(request, "nonce") as c_longlong,
            num(request, "api_key_index") as c_int,
            num(request, "account_index") as c_longlong,
        ))
    }
}

pub fn sign_modify_order(signer: &Value, request: &Value) -> Value {
    let lib = resolve(signer).unwrap_or_else(|e| fail("lighterSignModifyOrder", e));
    unsafe {
        let f = sym!(lib, "lighterSignModifyOrder", b"SignModifyOrder\0",
            unsafe extern "C" fn(c_int, c_longlong, c_longlong, c_longlong, c_longlong, c_longlong,
                                 c_int, c_int, u8, c_longlong, c_int, c_longlong) -> SignedTxResponse);
        signed(&lib, "lighterSignModifyOrder", f(
            num(request, "market_index") as c_int,
            num(request, "index") as c_longlong,
            num(request, "base_amount") as c_longlong,
            num(request, "price") as c_longlong,
            num(request, "trigger_price") as c_longlong,
            num(request, "integrator_account_index") as c_longlong,
            num(request, "integrator_taker_fee") as c_int,
            num(request, "integrator_maker_fee") as c_int,
            SKIP_NONCE,
            num(request, "nonce") as c_longlong,
            num(request, "api_key_index") as c_int,
            num(request, "account_index") as c_longlong,
        ))
    }
}

pub fn sign_withdraw(signer: &Value, request: &Value) -> Value {
    let lib = resolve(signer).unwrap_or_else(|e| fail("lighterSignWithdraw", e));
    unsafe {
        let f = sym!(lib, "lighterSignWithdraw", b"SignWithdraw\0",
            unsafe extern "C" fn(c_int, c_int, u64, u8, c_longlong, c_int, c_longlong) -> SignedTxResponse);
        signed(&lib, "lighterSignWithdraw", f(
            num(request, "asset_index") as c_int,
            num(request, "route_type") as c_int,
            num(request, "amount") as u64,
            SKIP_NONCE,
            num(request, "nonce") as c_longlong,
            num(request, "api_key_index") as c_int,
            num(request, "account_index") as c_longlong,
        ))
    }
}

pub fn sign_create_sub_account(signer: &Value, request: &Value) -> Value {
    let lib = resolve(signer).unwrap_or_else(|e| fail("lighterSignCreateSubAccount", e));
    unsafe {
        let f = sym!(lib, "lighterSignCreateSubAccount", b"SignCreateSubAccount\0",
            unsafe extern "C" fn(u8, c_longlong, c_int, c_longlong) -> SignedTxResponse);
        signed(&lib, "lighterSignCreateSubAccount", f(
            SKIP_NONCE,
            num(request, "nonce") as c_longlong,
            num(request, "api_key_index") as c_int,
            num(request, "account_index") as c_longlong,
        ))
    }
}

pub fn sign_transfer(signer: &Value, request: &Value) -> Value {
    let lib = resolve(signer).unwrap_or_else(|e| fail("lighterSignTransfer", e));
    let memo = CString::new(text(request, "memo")).unwrap_or_default();
    unsafe {
        let f = sym!(lib, "lighterSignTransfer", b"SignTransfer\0",
            unsafe extern "C" fn(c_longlong, i16, u8, u8, c_longlong, c_longlong, *mut c_char,
                                 u8, c_longlong, c_int, c_longlong) -> SignedTxResponse);
        signed(&lib, "lighterSignTransfer", f(
            num(request, "to_account_index") as c_longlong,
            num(request, "asset_index") as i16,
            num(request, "from_route_type") as u8,
            num(request, "to_route_type") as u8,
            num(request, "amount") as c_longlong,
            num(request, "usdc_fee") as c_longlong,
            memo.as_ptr() as *mut c_char,
            SKIP_NONCE,
            num(request, "nonce") as c_longlong,
            num(request, "api_key_index") as c_int,
            num(request, "account_index") as c_longlong,
        ))
    }
}

pub fn sign_update_leverage(signer: &Value, request: &Value) -> Value {
    let lib = resolve(signer).unwrap_or_else(|e| fail("lighterSignUpdateLeverage", e));
    unsafe {
        let f = sym!(lib, "lighterSignUpdateLeverage", b"SignUpdateLeverage\0",
            unsafe extern "C" fn(c_int, c_int, c_int, u8, c_longlong, c_int, c_longlong) -> SignedTxResponse);
        signed(&lib, "lighterSignUpdateLeverage", f(
            num(request, "market_index") as c_int,
            num(request, "initial_margin_fraction") as c_int,
            num(request, "margin_mode") as c_int,
            SKIP_NONCE,
            num(request, "nonce") as c_longlong,
            num(request, "api_key_index") as c_int,
            num(request, "account_index") as c_longlong,
        ))
    }
}

pub fn sign_update_margin(signer: &Value, request: &Value) -> Value {
    let lib = resolve(signer).unwrap_or_else(|e| fail("lighterSignUpdateMargin", e));
    unsafe {
        let f = sym!(lib, "lighterSignUpdateMargin", b"SignUpdateMargin\0",
            unsafe extern "C" fn(c_int, c_longlong, c_int, u8, c_longlong, c_int, c_longlong) -> SignedTxResponse);
        signed(&lib, "lighterSignUpdateMargin", f(
            num(request, "market_index") as c_int,
            num(request, "usdc_amount") as c_longlong,
            num(request, "direction") as c_int,
            SKIP_NONCE,
            num(request, "nonce") as c_longlong,
            num(request, "api_key_index") as c_int,
            num(request, "account_index") as c_longlong,
        ))
    }
}

pub fn sign_approve_integrator(signer: &Value, request: &Value) -> Value {
    let lib = resolve(signer).unwrap_or_else(|e| fail("lighterSignApproveIntegrator", e));
    unsafe {
        let f = sym!(lib, "lighterSignApproveIntegrator", b"SignApproveIntegrator\0",
            unsafe extern "C" fn(c_longlong, u32, u32, u32, u32, c_longlong, u8, c_longlong,
                                 c_int, c_longlong) -> SignedTxResponse);
        signed_with_message(&lib, "lighterSignApproveIntegrator", f(
            num(request, "integrator_account_index") as c_longlong,
            num(request, "integrator_taker_fee") as u32,
            num(request, "integrator_maker_fee") as u32,
            num(request, "integrator_taker_fee") as u32,
            num(request, "integrator_maker_fee") as u32,
            num(request, "approval_expiry") as c_longlong,
            SKIP_NONCE,
            num(request, "nonce") as c_longlong,
            num(request, "api_key_index") as c_int,
            num(request, "account_index") as c_longlong,
        ))
    }
}

pub fn sign_change_pubkey(signer: &Value, request: &Value) -> Value {
    let lib = resolve(signer).unwrap_or_else(|e| fail("lighterSignChangePubkey", e));
    let pubkey = CString::new(text(request, "pubkey")).unwrap_or_default();
    unsafe {
        let f = sym!(lib, "lighterSignChangePubkey", b"SignChangePubKey\0",
            unsafe extern "C" fn(*mut c_char, u8, c_longlong, c_int, c_longlong) -> SignedTxResponse);
        signed_with_message(&lib, "lighterSignChangePubkey", f(
            pubkey.as_ptr() as *mut c_char,
            SKIP_NONCE,
            num(request, "nonce") as c_longlong,
            num(request, "api_key_index") as c_int,
            num(request, "account_index") as c_longlong,
        ))
    }
}

// ─── tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // Committed test credentials, the same ones the static request fixture uses
    // (ts/src/test/static/request/lighter.json). Nothing here is sent anywhere:
    // every call below signs locally and throws the result away.
    const KEY: &str = "e5b975b33b81e53fb5333bd84553f12b3b5327ce5b1595139f49e8bebf734d9b1b81d3351b487d1b";
    const URL: &str = "https://mainnet.zklighter.elliot.ai";
    const ACCOUNT: i64 = 715085;
    const API_KEY_INDEX: i64 = 30;
    const CHAIN: i64 = 304;
    const NONCE: i64 = 7;

    /// The signer builds ship with the repo, one per platform. Returns `None`
    /// where lighter publishes no build, so the test skips instead of failing.
    fn library_path() -> Option<std::path::PathBuf> {
        let name = if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
            "lighter-signer-linux-amd64.so"
        } else if cfg!(all(target_os = "linux", target_arch = "aarch64")) {
            "lighter-signer-linux-arm64.so"
        } else if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
            "lighter-signer-darwin-arm64.dylib"
        } else if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
            "lighter-signer-windows-amd64.dll"
        } else {
            return None;
        };
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../ts/src/test/static/binaries")
            .join(name);
        if path.exists() {
            Some(path)
        } else {
            None
        }
    }

    /// A request dict with the credential fields every signer reads.
    fn req(mut extra: serde_json::Value) -> Value {
        let base = extra.as_object_mut().expect("object");
        base.insert("nonce".into(), json!(NONCE));
        base.insert("api_key_index".into(), json!(API_KEY_INDEX));
        base.insert("account_index".into(), json!(ACCOUNT));
        Value::from_json(&extra)
    }

    /// Unpack `[txType, txInfo]` and parse the payload back into JSON so the
    /// individual fields can be asserted — a wrong argument order or width in
    /// the C call shows up here as a shifted or truncated field, which is the
    /// whole point of the test.
    fn unpack(v: &Value) -> (i64, serde_json::Value) {
        let rows = match v {
            Value::Arr(a) => a.clone(),
            other => panic!("expected an array, got {other:?}"),
        };
        let tx_type = match &rows[0] {
            Value::Int(n) => *n,
            other => panic!("expected txType int, got {other:?}"),
        };
        let info = match &rows[1] {
            Value::Str(s) => serde_json::from_str(s).expect("txInfo is json"),
            other => panic!("expected txInfo string, got {other:?}"),
        };
        (tx_type, info)
    }

    /// `assert!(info[field] == expected)` with a readable failure.
    fn field_eq(what: &str, info: &serde_json::Value, key: &str, expected: serde_json::Value) {
        assert_eq!(info.get(key), Some(&expected), "{what}: wrong {key} in {info}");
    }

    /// Signs one payload per entry point and checks the decoded transaction.
    ///
    /// `ExpiredAt` (wall clock), `OrderExpiry` (derived from it) and `Sig` are
    /// not asserted: the library stamps the current time inside the call, so
    /// they differ run to run. That is the same set the static request fixtures
    /// list in `skipKeys`.
    #[test]
    fn signs_every_entry_point() {
        let Some(path) = library_path() else {
            eprintln!("no lighter signer build for this platform, skipping");
            return;
        };
        let signer = load_library(path.to_str().expect("utf-8 path"));
        // the generated exchange caches this handle through `safe_dict`, so it
        // has to come back as a dict carrying the path
        assert_eq!(
            crate::get_value(&signer, &Value::Str("libraryPath".to_string())),
            Value::Str(path.to_str().expect("utf-8 path").to_string()),
        );
        create_client(&signer, URL, KEY, CHAIN, API_KEY_INDEX, ACCOUNT);

        // ── create order ────────────────────────────────────────────────────
        let (tx_type, info) = unpack(&sign_create_order(&signer, &req(json!({
            "market_index": 1, "client_order_index": 1001, "base_amount": 1000,
            "avg_execution_price": 40000, "is_ask": 0, "order_type": 0,
            "time_in_force": 1, "reduce_only": 0, "trigger_price": 0,
            "order_expiry": -1, "integrator_account_index": 0,
            "integrator_taker_fee": 0, "integrator_maker_fee": 0,
        }))));
        assert_eq!(tx_type, 14);
        for (key, want) in [
            ("MarketIndex", json!(1)), ("ClientOrderIndex", json!(1001)),
            ("BaseAmount", json!(1000)), ("Price", json!(40000)), ("IsAsk", json!(0)),
            ("Type", json!(0)), ("TimeInForce", json!(1)), ("ReduceOnly", json!(0)),
            ("TriggerPrice", json!(0)), ("Nonce", json!(NONCE)),
            ("AccountIndex", json!(ACCOUNT)), ("ApiKeyIndex", json!(API_KEY_INDEX)),
        ] {
            field_eq("createOrder", &info, key, want);
        }

        // ── grouped orders ──────────────────────────────────────────────────
        // Grouping type 1 with two rows is the shape the library accepts: the
        // parent carries the amount, the child (type 3, stop loss) carries a
        // trigger and a nil amount — matching `// amount should be 0 for child
        // orders` in ts/src/lighter.ts.
        let (tx_type, info) = unpack(&sign_create_grouped_orders(&signer, &req(json!({
            "grouping_type": 1, "integrator_account_index": 0,
            "integrator_taker_fee": 0, "integrator_maker_fee": 0,
            "orders": [
                {"market_index": 1, "client_order_index": 0, "base_amount": 1000,
                 "avg_execution_price": 40000, "is_ask": 0, "order_type": 0,
                 "time_in_force": 1, "reduce_only": 0, "trigger_price": 0, "order_expiry": -1},
                {"market_index": 1, "client_order_index": 0, "base_amount": 0,
                 "avg_execution_price": 41000, "is_ask": 1, "order_type": 3,
                 "time_in_force": 1, "reduce_only": 1, "trigger_price": 41000, "order_expiry": -1},
            ],
        }))));
        assert_eq!(tx_type, 28);
        field_eq("groupedOrders", &info, "GroupingType", json!(1));
        let rows = info["Orders"].as_array().expect("orders array");
        assert_eq!(rows.len(), 2, "grouped orders: wrong row count in {info}");
        field_eq("groupedOrders[0]", &rows[0], "BaseAmount", json!(1000));
        field_eq("groupedOrders[0]", &rows[0], "Price", json!(40000));
        field_eq("groupedOrders[1]", &rows[1], "Type", json!(3));
        field_eq("groupedOrders[1]", &rows[1], "TriggerPrice", json!(41000));
        field_eq("groupedOrders[1]", &rows[1], "ReduceOnly", json!(1));

        // ── cancel / cancel all ─────────────────────────────────────────────
        let (tx_type, info) = unpack(&sign_cancel_order(
            &signer, &req(json!({"market_index": 1, "order_index": 555}))));
        assert_eq!(tx_type, 15);
        field_eq("cancelOrder", &info, "MarketIndex", json!(1));
        field_eq("cancelOrder", &info, "Index", json!(555));

        let (tx_type, info) = unpack(&sign_cancel_all_orders(
            &signer, &req(json!({"time_in_force": 0, "time": 0}))));
        assert_eq!(tx_type, 16);
        field_eq("cancelAllOrders", &info, "TimeInForce", json!(0));
        field_eq("cancelAllOrders", &info, "Time", json!(0));

        // ── modify ──────────────────────────────────────────────────────────
        let (tx_type, info) = unpack(&sign_modify_order(&signer, &req(json!({
            "market_index": 1, "index": 555, "base_amount": 2000, "price": 41000,
            "trigger_price": 0, "integrator_account_index": 0,
            "integrator_taker_fee": 0, "integrator_maker_fee": 0,
        }))));
        assert_eq!(tx_type, 17);
        field_eq("modifyOrder", &info, "Index", json!(555));
        field_eq("modifyOrder", &info, "BaseAmount", json!(2000));
        field_eq("modifyOrder", &info, "Price", json!(41000));

        // ── withdraw ────────────────────────────────────────────────────────
        let (tx_type, info) = unpack(&sign_withdraw(&signer, &req(json!({
            "asset_index": 1, "route_type": 0, "amount": 1000000,
        }))));
        assert_eq!(tx_type, 13);
        field_eq("withdraw", &info, "AssetIndex", json!(1));
        field_eq("withdraw", &info, "Amount", json!(1000000));
        field_eq("withdraw", &info, "FromAccountIndex", json!(ACCOUNT));

        // ── sub account ─────────────────────────────────────────────────────
        let (tx_type, info) = unpack(&sign_create_sub_account(&signer, &req(json!({}))));
        assert_eq!(tx_type, 9);
        field_eq("createSubAccount", &info, "AccountIndex", json!(ACCOUNT));

        // ── transfer ────────────────────────────────────────────────────────
        // The memo is hex for 32 bytes of ascii; the library decodes it and the
        // payload carries the raw bytes back.
        let (tx_type, info) = unpack(&sign_transfer(&signer, &req(json!({
            "to_account_index": 715086, "asset_index": 1, "from_route_type": 0,
            "to_route_type": 0, "amount": 1000000, "usdc_fee": 0,
            "memo": "63637874207265666572656e6365207061796c6f616420666f7220746573743a",
        }))));
        assert_eq!(tx_type, 12);
        field_eq("transfer", &info, "ToAccountIndex", json!(715086));
        field_eq("transfer", &info, "FromAccountIndex", json!(ACCOUNT));
        field_eq("transfer", &info, "AssetIndex", json!(1));
        field_eq("transfer", &info, "Amount", json!(1000000));
        field_eq("transfer", &info, "USDCFee", json!(0));
        assert_eq!(info["Memo"].as_array().map(|m| m.len()), Some(32),
                   "transfer: memo did not decode to 32 bytes in {info}");

        // ── leverage / margin ───────────────────────────────────────────────
        let (tx_type, info) = unpack(&sign_update_leverage(&signer, &req(json!({
            "market_index": 1, "initial_margin_fraction": 100, "margin_mode": 0,
        }))));
        assert_eq!(tx_type, 20);
        field_eq("updateLeverage", &info, "InitialMarginFraction", json!(100));
        field_eq("updateLeverage", &info, "MarginMode", json!(0));

        let (tx_type, info) = unpack(&sign_update_margin(&signer, &req(json!({
            "market_index": 1, "usdc_amount": 1000000, "direction": 0,
        }))));
        assert_eq!(tx_type, 29);
        field_eq("updateMargin", &info, "USDCAmount", json!(1000000));
        field_eq("updateMargin", &info, "Direction", json!(0));

        // ── the two flows that also return a message for the L1 key ─────────
        let approve = sign_approve_integrator(&signer, &req(json!({
            "integrator_account_index": 130303, "integrator_taker_fee": 10,
            "integrator_maker_fee": 10, "approval_expiry": 1893456000000i64,
        })));
        let (tx_type, info) = unpack(&approve);
        assert_eq!(tx_type, 45);
        field_eq("approveIntegrator", &info, "IntegratorAccountIndex", json!(130303));
        field_eq("approveIntegrator", &info, "MaxPerpsTakerFee", json!(10));
        field_eq("approveIntegrator", &info, "MaxSpotMakerFee", json!(10));
        field_eq("approveIntegrator", &info, "ApprovalExpiry", json!(1893456000000i64));
        let message = match &approve { Value::Arr(a) => a[2].clone(), _ => unreachable!() };
        match message {
            Value::Str(m) => assert!(m.contains("Approve Integrator"),
                                     "approveIntegrator: unexpected message {m}"),
            other => panic!("expected a message to sign, got {other:?}"),
        }

        let pubkey = "0x1b81d3351b487d1b3b5327ce5b1595139f49e8bebf734d9b1b81d3351b487d1b1b81d3351b487d1b";
        let change = sign_change_pubkey(&signer, &req(json!({"pubkey": pubkey})));
        let (tx_type, _info) = unpack(&change);
        assert_eq!(tx_type, 8);
        let message = match &change { Value::Arr(a) => a[2].clone(), _ => unreachable!() };
        match message {
            Value::Str(m) => assert!(m.contains(pubkey),
                                     "changePubkey: message does not carry the key: {m}"),
            other => panic!("expected a message to sign, got {other:?}"),
        }

        // ── generated api key ───────────────────────────────────────────────
        match generate_api_key(&signer) {
            Value::Arr(pair) => {
                let hex = |v: &Value| match v {
                    Value::Str(s) => s.clone(),
                    other => panic!("expected a hex string, got {other:?}"),
                };
                let (private, public) = (hex(&pair[0]), hex(&pair[1]));
                assert!(!private.is_empty() && !public.is_empty(),
                        "generateApiKey returned an empty pair");
                assert!(private.trim_start_matches("0x").chars().all(|c| c.is_ascii_hexdigit()),
                        "generateApiKey: private key is not hex: {private}");
                assert_ne!(private, public);
            }
            other => panic!("expected a [private, public] pair, got {other:?}"),
        }

        // ── auth token ──────────────────────────────────────────────────────
        let token = create_auth_token(&signer, &Value::from_json(&json!({
            "deadline": 1893456000, "api_key_index": API_KEY_INDEX, "account_index": ACCOUNT,
        })));
        match token {
            Value::Str(t) => assert!(t.starts_with(&format!("1893456000:{ACCOUNT}:{API_KEY_INDEX}:")),
                                     "createAuthToken: unexpected token {t}"),
            other => panic!("expected a token string, got {other:?}"),
        }
    }

    /// Lighter's public url is templated, and the robinhood-chain fork works by
    /// swapping exactly these two fields, so resolve them rather than hardcode.
    #[test]
    fn resolves_the_client_url() {
        let urls = Value::from_json(&json!({"api": {"public": "https://mainnet.{hostname}"}}));
        assert_eq!(
            client_url(&urls, &Value::Str("zklighter.elliot.ai".to_string())),
            "https://mainnet.zklighter.elliot.ai",
        );
        // a fork that only replaces the host is carried through unchanged
        assert_eq!(
            client_url(&urls, &Value::Str("lighter.robinhood.com".to_string())),
            "https://mainnet.lighter.robinhood.com",
        );
        // nothing to substitute, and nothing to resolve, are both non-fatal here
        let plain = Value::from_json(&json!({"api": {"public": "https://example.test"}}));
        assert_eq!(client_url(&plain, &Value::Null), "https://example.test");
        assert_eq!(client_url(&Value::Null, &Value::Null), "");
    }

    /// A missing library has to fail loudly rather than sign with nothing.
    #[test]
    #[should_panic(expected = "lighter loadLighterLibrary()")]
    fn missing_library_fails_loudly() {
        load_library("/nonexistent/lighter-signer.so");
    }
}
