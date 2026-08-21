---
name: ccxt-rust
description: CCXT cryptocurrency exchange library for Rust developers. Covers both REST API (standard) and WebSocket API (real-time). Helps add the crates, connect to exchanges, fetch market data, place orders, stream live tickers/orderbooks, handle authentication, and manage errors in Rust projects. Use when working with crypto exchanges in Rust applications, trading systems, or market-data services.
---

# CCXT for Rust

Using CCXT from Rust: 103 REST exchanges and 76 WebSocket venues, transpiled from the
TypeScript source of truth.

> **Status: preview.** The Rust target is newer than the other CCXT languages and its
> public API still diverges from them in ways that matter. Read
> [Differences from other CCXT languages](#differences-from-other-ccxt-languages)
> before porting code from Python/TypeScript — most of it does not translate line-for-line.

## Installation

The crates are **not yet published to crates.io**. Depend on the git repository:

```toml
[dependencies]
# Typed unified API. Re-exports the whole ccxt-base engine at its root,
# so `ccxt::Value`, `ccxt::runtime::…` resolve here too.
ccxt = { git = "https://github.com/ccxt/ccxt", package = "ccxt" }
tokio = { version = "1", features = ["full"] }

# Optional: WebSocket (`watch_*`) venues.
ccxt-pro = { git = "https://github.com/ccxt/ccxt", package = "ccxt-pro" }
# Optional: prediction markets (kalshi, polymarket, limitless, myriad).
ccxt-prediction = { git = "https://github.com/ccxt/ccxt", package = "ccxt-prediction" }
```

Or, working inside a checkout of the repo:

```toml
ccxt     = { path = "…/ccxt/rust/ccxt" }
ccxt-pro = { path = "…/ccxt/rust/ccxt-pro" }
```

### Crate layout

| Crate | Contains |
|---|---|
| `ccxt-base` | the engine: `Value`, runtime, HTTP, crypto, REST exchange Cores |
| `ccxt` | **depend on this one** — typed wrappers (`Binance`, `Kraken`, …) + re-exports all of `ccxt-base` |
| `ccxt-pro` | transpiled WebSocket venues and their typed `watch_*` wrappers |
| `ccxt-prediction` | prediction-market venues |

`transpiled-base` is a feature of **`ccxt-base`**, not of `ccxt`. Do not put
`features = ["transpiled-base"]` on the `ccxt` dependency — it will fail to resolve.

### Build expectations

This is a very large generated codebase (~820k lines). A cold build takes **several
minutes** and `target/` can reach **~11 GB**. On a 16 GB machine, prefer:

```bash
CARGO_PROFILE_DEV_DEBUG=0 CARGO_BUILD_JOBS=1 cargo build
```

Debug info on a crate this size is the main driver of peak `rustc` memory.

## Quick start

```rust
use ccxt::{Value, TypedExchangeExt};

#[tokio::main]
async fn main() -> Result<(), ccxt::ExchangeError> {
    let mut ex = ccxt::Kraken::new(None);

    ex.load_markets(false).await;          // note: returns Value, NOT Result

    let t = ex.fetch_ticker("BTC/USD", Value::Null).await?;
    println!("last={:?} bid={:?} ask={:?}", t.last, t.bid, t.ask);
    Ok(())
}
```

Two things that trip up everyone coming from another CCXT language:

1. **`params` is a required positional argument on every method.** Pass `Value::Null`
   when you have no extra params. There are no default arguments in Rust.
2. **`load_markets` returns `Value`, not `Result`** — see
   [load_markets error handling](#load_markets-does-not-return-result).

## Creating an exchange instance

### By concrete type

```rust
let mut ex = ccxt::Binance::new(None);
let mut ex = ccxt::Kraken::new(None);
let mut ex = ccxt::Okx::new(None);
```

### By id (factory)

```rust
use ccxt::{TypedExchange, TypedExchangeExt, Value};

let mut ex: Box<dyn TypedExchange> = ccxt::from_id("kraken", None)
    .expect("unknown exchange id");
let t = ex.fetch_ticker("BTC/USD", Value::Null).await?;
```

`ccxt::from_id` covers all 103 REST exchanges; `ccxt_pro::from_id` covers the 76 WS venues.
Use this when the exchange is chosen at runtime.

### Trait imports you will need

| Trait | Gives you |
|---|---|
| `ccxt::TypedExchangeExt` | the typed unified methods (`fetch_ticker`, `create_order`, …) |
| `ccxt::TypedExchange` | `call_raw`, and object safety for `Box<dyn TypedExchange>` |
| `ccxt::exchange_generated::ExchangeBase` | untyped base helpers such as `market()` |

Forgetting `TypedExchangeExt` produces confusing "method not found" or
"expected `Value`, found `&str`" errors, because the call falls through to the untyped
Core instead. See [Three overlapping method surfaces](#three-overlapping-method-surfaces).

## Common REST operations

All verified against live public endpoints.

```rust
use ccxt::{Value, TypedExchangeExt, TypedExchange};

// Ticker
let t = ex.fetch_ticker("BTC/USD", Value::Null).await?;
println!("{:?} {:?} {:?}", t.last, t.bid, t.ask);

// Order book
let ob = ex.fetch_order_book("BTC/USD", Some(5), Value::Null).await?;
println!("{} bids, top {:?}", ob.bids.len(), ob.bids.first());

// Recent trades
let trades = ex.fetch_trades("BTC/USD", None, Some(10), Value::Null).await?;

// All tickers
let all = ex.fetch_tickers(None, Value::Null).await?;   // Tickers = map<String, Ticker>

// Balance (private — requires credentials)
let bal = ex.fetch_balance(Value::Null).await?;
```

### OHLCV — no typed wrapper

`fetch_ohlcv` has **no typed method**. It is reachable only through the untyped
dispatcher, and you parse the `Value` yourself:

```rust
use ccxt::{TypedExchange, Value};

let raw = ex.call_raw("fetch_ohlcv", vec![
    Value::Str("BTC/USD".into()),
    Value::Str("1h".into()),
    Value::Null,          // since
    Value::Int(5),        // limit
    Value::Null,          // params
]).await?;

if let Value::Arr(rows) = raw {
    for row in rows.iter() {
        // [timestamp, open, high, low, close, volume]
        println!("{row:?}");
    }
}
```

Do **not** try `ex.fetch_ohlcv(...)` on a typed wrapper. It resolves to the untyped Core
method through `Deref` and then fails to compile with
`E0596: cannot borrow data in dereference of ... as mutable`, because `DerefMut` is
intentionally not implemented. `call_raw` is the supported route.

`fetch_l2_order_book` is missing from the typed surface for the same reason.

## WebSocket operations

Requires the `ccxt-pro` crate. Each `watch_*` call resolves to **one** update; loop to keep
consuming.

```rust
use ccxt::Value;
use ccxt_pro::{from_id, TypedExchange, TypedExchangeExt};

#[tokio::main]
async fn main() {
    let mut ex: Box<dyn TypedExchange> = from_id("kraken", None).unwrap();
    ex.load_markets(false).await;

    loop {
        match ex.watch_ticker("BTC/USD", Value::Null).await {
            Ok(t) => println!("last={:?}", t.last),
            Err(e) => { eprintln!("[{}] {}", e.kind, e.message); break; }
        }
    }
}
```

```rust
// Order book — `limit` is best-effort; venues may send more levels than requested.
let ob = ex.watch_order_book("BTC/USD", Some(10), Value::Null).await?;

// Trades — returns the batch delivered in this update.
let trades = ex.watch_trades("BTC/USD", None, None, Value::Null).await?;

// Multiple symbols in one subscription.
let ob = ex.watch_order_book_for_symbols(
    vec!["BTC/USD".into(), "ETH/USD".into()], Some(10), Value::Null).await?;
```

Always wrap a `watch_*` in `tokio::time::timeout` if you need liveness guarantees — a
quiet market simply does not resolve the future.

**One in-flight call per instance.** `watch_*` and `fetch_*` take `&mut self`, so you
cannot borrow the same exchange twice concurrently. To stream several symbols in parallel,
create one instance per task.

## Authentication

Credentials go in the constructor config, as a `Value` dict with **camelCase** string keys
(the TS names, not snake_case):

```rust
use ccxt::Value;
use indexmap::IndexMap;

let mut cfg = IndexMap::new();
cfg.insert("apiKey".to_string(), Value::Str(std::env::var("BINANCE_APIKEY")?));
cfg.insert("secret".to_string(), Value::Str(std::env::var("BINANCE_SECRET")?));

let mut ex = ccxt::Binance::new(Some(Value::Dict(std::sync::Arc::new(cfg))));
```

Recognised credential keys (per exchange — check `requiredCredentials` in the exchange's
`describe()`):

```
apiKey, secret, password, uid, walletAddress, privateKey, token, twofa, login, accountId
```

Never hardcode keys. A worked example of loading them from `keys.local.json` or the
environment is in `examples/rust/src/cli.rs`.

### Placing an order

```rust
let order = ex.create_order(
    "BTC/USDT",
    "limit",      // type  — stringly typed, no enum
    "buy",        // side  — "buy" | "sell"
    0.001,        // amount
    Some(50000.0),// price (None for market orders)
    Value::Null,  // params
).await?;

println!("{:?} {:?}", order.id, order.status);

ex.cancel_order(order.id.as_deref().unwrap(), Some("BTC/USDT"), Value::Null).await?;
```

`type` and `side` are `&str`, not enums — a typo compiles fine and fails at the exchange.

> Some exchange-specific signers (paradex/StarkNet, lighter zk-proofs, dydx protobuf,
> apex StarkEx, curve25519) are not yet ported and fail with `NotSupported`. Public
> endpoints on those venues work.

## Unified structure fields

The Rust structs are **subsets** of the unified structures documented in
`wiki/Manual.md`. Anything missing is still available in the `raw` field.

```rust
pub struct Ticker {
    pub symbol: String, pub timestamp: Option<i64>, pub datetime: Option<String>,
    pub high: Option<f64>, pub low: Option<f64>,
    pub bid: Option<f64>, pub ask: Option<f64>, pub last: Option<f64>,
    pub base_volume: Option<f64>, pub quote_volume: Option<f64>,
    pub raw: Value,
}

pub struct Trade {
    pub id: Option<String>, pub symbol: String,
    pub timestamp: Option<i64>, pub datetime: Option<String>,
    pub side: Option<String>, pub price: Option<f64>,
    pub amount: Option<f64>, pub cost: Option<f64>,
    pub raw: Value,
}

pub struct Order {
    pub id: Option<String>, pub client_order_id: Option<String>,
    pub symbol: String, pub timestamp: Option<i64>, pub datetime: Option<String>,
    pub status: Option<String>, pub order_type: Option<String>, pub side: Option<String>,
    pub price: Option<f64>, pub amount: Option<f64>,
    pub filled: Option<f64>, pub remaining: Option<f64>, pub cost: Option<f64>,
    pub fee: Option<HashMap<String, Value>>,
    pub raw: Value,
}

pub struct OrderBook {
    pub symbol: Option<String>, pub timestamp: Option<i64>, pub datetime: Option<String>,
    pub bids: Vec<[f64; 2]>, pub asks: Vec<[f64; 2]>,   // [price, amount]
    pub nonce: Option<i64>, pub raw: Value,
}

pub struct Market {
    pub id: String, pub symbol: String, pub base: String, pub quote: String,
    pub settle: Option<String>, pub base_id: String, pub quote_id: String,
    pub market_type: String, pub spot: bool, pub margin: bool, pub swap: bool,
    pub future: bool, pub option: bool, pub active: bool, pub contract: bool,
    pub linear: Option<bool>, pub inverse: Option<bool>,
    pub taker: Option<f64>, pub maker: Option<f64>,
    pub raw: Value,
}
```

Fields present in other CCXT languages but **not** on the Rust structs:

| Struct | Missing here — read from `raw` instead |
|---|---|
| `Ticker` | `bidVolume`, `askVolume`, `vwap`, `open`, `close`, `previousClose`, `change`, `percentage`, `average`, `indexPrice`, `markPrice` |
| `Trade` | `order`, `type`, `takerOrMaker`, `fee` |
| `Order` | `timeInForce`, `average`, `stopPrice`, `triggerPrice`, `takeProfitPrice`, `stopLossPrice`, `trades`, `reduceOnly`, `postOnly`, `lastTradeTimestamp`, `lastUpdateTimestamp` |
| `Market` | **`precision`**, **`limits`**, `contractSize`, `expiry`, `strike`, `optionType`, `subType` |

### Reading from `raw`

`raw` is a `Value` keyed by the **camelCase** names from the unified structures.
`get_value` takes a `Value` key, not a `&str`:

```rust
use ccxt::{get_value, Value};

let pct = get_value(&ticker.raw, &Value::Str("percentage".into()));
```

Precision and limits, which `Market` does not expose, come from `market()`:

```rust
use ccxt::exchange_generated::ExchangeBase;

let m = ex.market(Value::Str("BTC/USD".into()));
let amount_precision = get_value(
    &get_value(&m, &Value::Str("precision".into())),
    &Value::Str("amount".into()));
```

## Error handling

Errors are a single struct with a **string** `kind`, not an enum:

```rust
pub struct ExchangeError { pub kind: String, pub message: String }
```

`is()` / `is_a()` walk the CCXT error hierarchy, so you can match a base class:

```rust
match ex.fetch_ticker("BTC/USD", Value::Null).await {
    Ok(t) => println!("{:?}", t.last),
    Err(e) if e.is("NetworkError")        => { /* transient — retry */ }
    Err(e) if e.is("AuthenticationError") => { /* bad keys */ }
    Err(e) if e.is("InsufficientFunds")   => { /* top up */ }
    Err(e) => eprintln!("[{}] {}", e.kind, e.message),
}
```

Because `kind` is a string there is **no compiler check**: `e.is("NetwrokError")` compiles
and silently returns `false`. Copy these names exactly.

Common kinds: `NetworkError`, `RequestTimeout`, `DDoSProtection`, `ExchangeNotAvailable`,
`AuthenticationError`, `PermissionDenied`, `InsufficientFunds`, `InvalidOrder`,
`OrderNotFound`, `BadSymbol`, `BadRequest`, `NotSupported`, `RateLimitExceeded`.

### Panic messages on stderr

Errors are raised internally with `panic!` and recovered with `catch_unwind`. A **handled**
`Err` may still print a panic message and a `RUST_BACKTRACE` note to stderr. This is
expected and does not mean your program crashed — check the `Result`, not stderr.

Consequence: **do not set `panic = "abort"`** in your release profile. It converts every
CCXT error into a process abort.

## Rate limiting

`enableRateLimit` is on by default and spaces requests by the exchange's `rateLimit` ms,
weighted per endpoint. Leave it on unless you throttle externally.

## Differences from other CCXT languages

Read this before porting Python or TypeScript code.

| Concern | Python / TS | Rust |
|---|---|---|
| `params` argument | optional, defaults to `{}` | **required positional** — pass `Value::Null` |
| `load_markets()` | `await ex.load_markets()` | `ex.load_markets(false).await` — bool arg, returns `Value` |
| `ticker.info` | `.info` | **`.raw`** |
| `order.type` | `.type` | **`.order_type`** |
| `market.type` | `.type` | **`.market_type`** |
| `fetch_ohlcv` | typed method | **no typed method** — use `call_raw` |
| Error handling | `except ccxt.NetworkError` | `e.is("NetworkError")` — string, unchecked |
| Method naming | `fetchOrderBook` | `fetch_order_book` — plain camelCase→snake_case |
| Concurrency | many in-flight per instance | **one** — methods take `&mut self` |

### `load_markets` does not return `Result`

It returns `Value`, so failures do not surface as an `Err`. Worse, the behaviour differs by
receiver type:

| Receiver | On failure |
|---|---|
| concrete wrapper (`Kraken`) | **panics and aborts the process** |
| `Box<dyn TypedExchange>` | silently returns `Value::Null` |

Always check the result rather than trusting it succeeded:

```rust
let markets = ex.load_markets(false).await;
let n = match &markets { Value::Dict(d) => d.len(), _ => 0 };
if n == 0 {
    eprintln!("load_markets returned no markets — treat as failure");
    return;
}
```

If you need a real error, call the method through the dispatcher instead:

```rust
let markets = ex.call_raw("load_markets", vec![Value::Bool(false)]).await?;
```

### Three overlapping method surfaces

The same method name can resolve to three different things:

| Surface | `fetch_ticker` signature |
|---|---|
| inherent, on `Binance` | `(&str, Value) -> Result<Ticker>` |
| `TypedExchangeExt` trait | `(&str, Value) -> Result<Ticker>` |
| `BinanceCore` via `Deref` | `(Value, &[Value]) -> Value` |

If a call unexpectedly wants `Value` where you passed `&str`, you have fallen through to
the untyped Core — either import `TypedExchangeExt`, or the typed method does not exist
for that method name (as with `fetch_ohlcv`).

## Common pitfalls

1. **`features = ["transpiled-base"]` on the `ccxt` dependency** — that feature belongs to
   `ccxt-base`. Cargo fails to resolve.
2. **Passing only the symbol** — every method needs its trailing `params`, e.g.
   `fetch_ticker("BTC/USD", Value::Null)`.
3. **`.info`** — it is `.raw` in Rust.
4. **`ticker.percentage` / `.open` / `.close`** — not on the struct; read from `.raw`.
5. **`market.precision` / `.limits`** — not on `Market`; use `ex.market(...)` and
   `get_value`.
6. **Reusing one instance across concurrent tasks** — `&mut self` forbids it. One instance
   per task.
7. **Trusting stderr** — handled errors print panic text. Check the `Result`.
8. **`panic = "abort"`** — breaks all error handling.
9. **Unified symbols, not exchange ids** — always `"BTC/USDT"`, never `"BTCUSDT"`.
10. **Not calling `load_markets` first** — symbol resolution needs it.

## Prediction markets

Prediction venues (`kalshi`, `polymarket`, `limitless`, `myriad`, and the prediction
flavour of `hyperliquid`) live in `ccxt-prediction` and share a `PredictionExchange` base
built around events → markets → outcomes. See `examples/rust/src/prediction_typed_demo.rs`.

## Learn more

- Unified API spec: `wiki/Manual.md`
- Runnable examples: `examples/rust/src/` (`binance_typed.rs`, `watch_trades_count.rs`, `cli.rs`)
- Rust crate notes: `rust/ccxt-base/README.md`
- Exchange behaviour is transpiled from `ts/src/<exchange>.ts` — that file is the source of
  truth for what any method actually does.
