#!/usr/bin/env tsx
/**
 * Java Typed Method Generator for CCXT
 *
 * Reads TypeScript Exchange.ts via ast-transpiler to extract method signatures,
 * then injects typed overloads directly into Exchange.java.
 *
 * The typed methods coexist with the untyped methods via Java overloading:
 * - fetchTrades(String, Long, Long, Map) → List<Trade>   (typed, user-facing)
 * - fetchTrades(Object, Object...)       → CompletableFuture<Object> (untyped, internal)
 *
 * Java's overload resolution correctly picks the typed version for user code
 * (String args) and the untyped version for internal transpiled code (Object args).
 *
 * Usage: tsx build/generateJavaWrappers.ts
 */

import Transpiler from "ast-transpiler";
import * as fs from 'fs';

const TS_BASE_FILE = './ts/src/base/Exchange.ts';
const EXCHANGE_JAVA_FILE = './java/lib/src/main/java/io/github/ccxt/Exchange.java';
// Shared JSON file consumed by the Java transpiler (javaTranspiler.ts) to know which
// methods have typed overloads and need (Object) casts in internal calls.
const TYPED_METHODS_JSON = './build/java-typed-methods.json';

// Marker comment used to find the injection point in Exchange.java
const TYPED_METHODS_MARKER = '// === TYPED METHODS START (AUTO-GENERATED — DO NOT EDIT BELOW THIS LINE) ===';
const TYPED_METHODS_END_MARKER = '// === TYPED METHODS END ===';

// Known CCXT types that have Java equivalents in io.github.ccxt.types
const KNOWN_TYPES = new Set([
    'Ticker', 'Tickers', 'Trade', 'Order', 'OrderBook', 'OHLCV',
    'MarketInterface', 'Currencies', 'CurrencyInterface', 'Account', 'Balance', 'Balances',
    'Position', 'FundingRate', 'FundingRates', 'FundingRateHistory',
    'OpenInterest', 'OpenInterests', 'Liquidation',
    'LeverageTier', 'LeverageTiers', 'Leverage', 'Leverages',
    'MarginMode', 'MarginModes', 'MarginModification',
    'Transaction', 'DepositAddress', 'TransferEntry',
    'LedgerEntry', 'TradingFeeInterface', 'TradingFees',
    'Greeks', 'Option', 'OptionChain', 'Conversion',
    'LastPrice', 'LastPrices', 'LongShortRatio',
    'BorrowInterest', 'CrossBorrowRate', 'CrossBorrowRates',
    'IsolatedBorrowRate', 'IsolatedBorrowRates',
    'FundingHistory', 'DepositWithdrawFee',
    'OrderRequest', 'CancellationRequest', 'WithdrawalResponse',
]);

// --- Type helpers ---
function isStringType(t: string) { return t === 'Str' || t === 'string' || t === 'StringLiteral' || t === 'OrderSide' || t === 'OrderType' || t === 'MarketType'; }
function isNumberType(t: string) { return t === 'Num' || t === 'number' || t === 'NumericLiteral'; }
function isIntegerType(t: string) { return t !== undefined && t.toLowerCase() === 'int'; }
function isBooleanType(t: string) { return t === 'boolean' || t === 'Bool'; }
function isObjectType(t: string) { return t === 'any' || t === 'unknown' || t === 'Dict' || t === 'Object' || t === 'Dictionary<any>' || (t?.startsWith('{') && t?.endsWith('}')); }

function tsTypeToJavaType(tsType: string | undefined, isReturn = false): string {
    if (!tsType) return 'Object';
    if (isStringType(tsType)) return 'String';
    if (isIntegerType(tsType)) return 'Long';
    if (isNumberType(tsType)) return 'Double';
    if (isBooleanType(tsType)) return 'Boolean';
    if (tsType === 'Strings') return 'List<String>';
    if (isObjectType(tsType)) return isReturn ? 'Map<String, Object>' : 'Object';
    if (KNOWN_TYPES.has(tsType)) return tsType;
    return 'Object';
}

function tsReturnTypeToJava(methodName: string, tsReturnType: string): { javaType: string, isArray: boolean, elementType: string | null } | null {
    // Special cases
    if (methodName === 'fetchTime') return { javaType: 'Long', isArray: false, elementType: null };
    if (methodName.startsWith('watchOrderBook')) return { javaType: 'OrderBook', isArray: false, elementType: null };
    if (methodName === 'watchOHLCVForSymbols') return null; // complex nested type, skip

    const isPromise = tsReturnType.startsWith('Promise<') && tsReturnType.endsWith('>');
    let inner = isPromise ? tsReturnType.slice(8, -1) : tsReturnType;

    // Array type
    if (inner.endsWith('[]')) {
        const elem = inner.slice(0, -2);
        if (KNOWN_TYPES.has(elem)) return { javaType: `List<${elem}>`, isArray: true, elementType: elem };
        if (elem === 'string') return { javaType: 'List<String>', isArray: true, elementType: null };
        return null;
    }

    // Known type
    if (KNOWN_TYPES.has(inner)) return { javaType: inner, isArray: false, elementType: null };

    // Primitive
    if (isIntegerType(inner) || inner === 'number' && methodName === 'fetchTime') return { javaType: 'Long', isArray: false, elementType: null };
    if (isNumberType(inner)) return { javaType: 'Double', isArray: false, elementType: null };
    if (isStringType(inner)) return { javaType: 'String', isArray: false, elementType: null };
    if (isBooleanType(inner)) return { javaType: 'Boolean', isArray: false, elementType: null };

    // Dict/object - skip
    if (isObjectType(inner)) return null;
    if (inner === 'void') return null;
    if (inner.startsWith('Dictionary<')) return null;
    if (inner.startsWith('{')) return null;
    if (inner === 'string[][]') return null;

    return null;
}

// --- Allowed method filter (matches Go/C# transpiler logic) ---
const ALLOWED_PREFIXES = ['fetch', 'create', 'edit', 'cancel', 'setP', 'setM', 'setL', 'transfer', 'withdraw', 'watch', 'unWatch'];
const BLACKLIST = new Set([
    'fetch', 'fetchCurrenciesWs', 'fetchMarketsWs', 'setSandBoxMode', 'loadOrderBook',
    'loadMarketsHelper', 'createNetworksByIdObject', 'setMarketsFromExchange',
    'setProperty', 'setProxyAgents', 'watch', 'watchMultiple', 'watchMultipleSubscription',
    'watchPrivate', 'watchPublic', 'setPositionsCache', 'setPositionCache',
    'watchMany', 'watchMultiHelper', 'watchMultipleWrapper', 'watchMultiRequest',
    'watchMultiTicker', 'watchMultiTickerHelper', 'watchPrivateMultiple',
    'watchPrivateRequest', 'watchPrivateSubscribe', 'watchPublicMultiple',
    'watchSpotPrivate', 'watchSwapPrivate', 'watchSpotPublic', 'watchSwapPublic',
    'watchTopics', 'createContractOrder', 'createSpotOrder', 'createSwapOrder', 'createVault',
    'fetchRestOrderBookSafe', 'fetchPortfolioDetails', 'unWatch', 'unWatchChannel', 'unWatchMultiple',
    'unWatchPrivate', 'unWatchPublic', 'unWatchPublicMultiple', 'unWatchTopics',
]);

/**
 * Scan Exchange.java (and optionally exchange files) to find methods that are called
 * internally with zero args, e.g., this.fetchAccounts().join() or exchange.fetchBalance().
 * These must NOT get zero-arg typed convenience overloads.
 */
function detectZeroArgInternalCalls(): Set<string> {
    const result = new Set<string>();
    const files = [EXCHANGE_JAVA_FILE];
    // Also scan exchange implementation files
    const exchangesDir = './java/lib/src/main/java/io/github/ccxt/exchanges/';
    if (fs.existsSync(exchangesDir)) {
        for (const f of fs.readdirSync(exchangesDir).filter(f => f.endsWith('.java'))) {
            files.push(exchangesDir + f);
        }
    }
    // Also scan test files
    const testsDir = './java/tests/src/main/java/tests/exchange/';
    if (fs.existsSync(testsDir)) {
        for (const f of fs.readdirSync(testsDir).filter(f => f.endsWith('.java'))) {
            files.push(testsDir + f);
        }
    }
    // Match patterns like: this.fetchAccounts() or exchange.fetchBalance()
    // where there are no arguments inside the parens
    const pattern = /(?:this|exchange)\.(\w+)\(\)/g;
    for (const file of files) {
        try {
            const content = fs.readFileSync(file, 'utf-8');
            let match;
            while ((match = pattern.exec(content)) !== null) {
                result.add(match[1]);
            }
        } catch { /* skip missing files */ }
    }
    return result;
}

const ZERO_ARG_INTERNAL_CALLS = detectZeroArgInternalCalls();

function shouldCreateWrapper(name: string): boolean {
    if (BLACKLIST.has(name)) return false;
    if (name.toLowerCase().includes('uta')) return false;
    if (name.includes('Snapshot') || name.includes('Subscription') || name.includes('Cache')) return false;
    return ALLOWED_PREFIXES.some(p => name.startsWith(p));
}

interface ParamInfo {
    name: string;
    javaType: string;
    isOptional: boolean;
    defaultValue: string | null;
}

interface MethodInfo {
    name: string;
    javaReturnType: string;
    isArray: boolean;
    elementType: string | null;
    requiredParams: ParamInfo[];
    optionalParams: ParamInfo[];
    isWatch: boolean;
}

function parseMethodsFromTS(): MethodInfo[] {
    const transpiler = new Transpiler({ verbose: false, csharp: { parser: { ELEMENT_ACCESS_WRAPPER_OPEN: "getValue(", ELEMENT_ACCESS_WRAPPER_CLOSE: ")" } } });
    const baseFile: any = transpiler.transpileJavaByPath(TS_BASE_FILE);
    const methodsTypes = baseFile.methodsTypes || [];

    const methods: MethodInfo[] = [];

    for (const m of methodsTypes) {
        if (!m.async) continue;
        if (!shouldCreateWrapper(m.name)) continue;

        const ret = tsReturnTypeToJava(m.name, m.returnType);
        if (!ret) continue;

        const requiredParams: ParamInfo[] = [];
        const optionalParams: ParamInfo[] = [];

        for (const p of m.parameters) {
            const isOptional = p.optional || p.initializer !== undefined;
            const isParams = p.name === 'params';
            const javaType = tsTypeToJavaType(p.type, false);

            if (isParams) {
                // params always goes last and is Map<String, Object>
                optionalParams.push({ name: 'params', javaType: 'Map<String, Object>', isOptional: true, defaultValue: 'null' });
            } else if (isOptional) {
                let defaultValue: string | null = null;
                if (p.initializer && p.initializer !== 'undefined' && p.initializer !== '{}') {
                    defaultValue = p.initializer.replace(/'/g, '"');
                }
                optionalParams.push({ name: safeName(p.name), javaType, isOptional: true, defaultValue });
            } else {
                requiredParams.push({ name: safeName(p.name), javaType, isOptional: false, defaultValue: null });
            }
        }

        // Ensure params is always present at the end
        if (!optionalParams.some(p => p.name === 'params')) {
            optionalParams.push({ name: 'params', javaType: 'Map<String, Object>', isOptional: true, defaultValue: 'null' });
        }

        methods.push({
            name: m.name,
            javaReturnType: ret.javaType,
            isArray: ret.isArray,
            elementType: ret.elementType,
            requiredParams,
            optionalParams,
            isWatch: m.name.startsWith('watch'),
        });
    }

    return methods;
}

function safeName(name: string): string {
    const reserved: Record<string, string> = { 'type': 'type', 'params': 'params' };
    return reserved[name] || name;
}

function camelCase(name: string): string {
    return name.charAt(0).toLowerCase() + name.slice(1);
}

function genReturnExpr(m: MethodInfo): string {
    if (m.isArray && m.elementType) return `toTypedList(res, ${m.elementType}::new)`;
    if (m.javaReturnType === 'Long') return '(res instanceof Number n) ? n.longValue() : null';
    if (m.javaReturnType === 'Double') return '(res instanceof Number n) ? n.doubleValue() : null';
    if (m.javaReturnType === 'String') return '(String) res';
    if (m.javaReturnType === 'Boolean') return '(Boolean) res';
    if (m.javaReturnType === 'Map<String, Object>') return '(Map<String, Object>) res';
    return `new ${m.javaReturnType}(res)`;
}

function genAsyncReturnExpr(m: MethodInfo): string {
    if (m.isArray && m.elementType) return `res -> toTypedList(res, ${m.elementType}::new)`;
    if (m.javaReturnType === 'Long') return 'res -> (res instanceof Number n) ? n.longValue() : null';
    if (m.javaReturnType === 'Double') return 'res -> (res instanceof Number n) ? n.doubleValue() : null';
    if (m.javaReturnType === 'String') return 'res -> (String) res';
    if (m.javaReturnType === 'Boolean') return 'res -> (Boolean) res';
    if (m.javaReturnType === 'Map<String, Object>') return 'res -> (Map<String, Object>) res';
    return `${m.javaReturnType}::new`;
}

/**
 * Generate the call expression that delegates to the untyped method.
 * ALL args are cast to (Object) to ensure Java picks the untyped varargs overload
 * instead of recursing into the typed overload. This is necessary because:
 * - Casting just the first arg works when the typed method's first param is specific (e.g., String)
 * - But fails when the typed method's first param is also Object (e.g., watchLiquidationsForSymbols)
 * - Casting all args guarantees the typed fixed-arity overload never matches
 */
function genDelegateCall(methodName: string, allParams: ParamInfo[]): string {
    if (allParams.length === 0) {
        return `this.${methodName}((Object) null)`;
    }
    const args = allParams.map(p => `(Object) ${p.name}`).join(', ');
    return `this.${methodName}(${args})`;
}

function genMethod(m: MethodInfo): string {
    const methodName = camelCase(m.name);
    const allParams = [...m.requiredParams, ...m.optionalParams];
    const fullParamDecl = allParams.map(p => `${p.javaType} ${p.name}`).join(', ');
    const delegateCall = genDelegateCall(methodName, allParams);

    const lines: string[] = [];

    // Full sync method with all params
    lines.push(`    public ${m.javaReturnType} ${methodName}(${fullParamDecl}) {`);
    lines.push(`        Object res = ${delegateCall}.join();`);
    lines.push(`        return ${genReturnExpr(m)};`);
    lines.push(`    }`);

    // Convenience overload: required params only (optional params default to null)
    // Skip when:
    // 1. Zero-arg overloads for methods called internally with zero args
    // 2. When all required params are Object type (indistinguishable from untyped varargs)
    if (m.optionalParams.length > 0) {
        const hasZeroArgConflict = ZERO_ARG_INTERNAL_CALLS.has(m.name) && m.requiredParams.length === 0;
        const allRequiredAreObject = m.requiredParams.length > 0 && m.requiredParams.every(p => p.javaType === 'Object');
        if (!hasZeroArgConflict && !allRequiredAreObject) {
            const reqDecl = m.requiredParams.map(p => `${p.javaType} ${p.name}`).join(', ');
            const reqArgs = m.requiredParams.map(p => p.name).join(', ');
            // Cast nulls to their specific types to avoid ambiguity with Object... varargs
            const defaults = m.optionalParams.map(p => {
                if (p.defaultValue && p.defaultValue !== 'null') return p.defaultValue;
                return `(${p.javaType}) null`;
            }).join(', ');
            const sep = reqArgs ? ', ' : '';
            if (reqDecl) {
                lines.push(`    public ${m.javaReturnType} ${methodName}(${reqDecl}) { return ${methodName}(${reqArgs}${sep}${defaults}); }`);
            } else {
                lines.push(`    public ${m.javaReturnType} ${methodName}() { return ${methodName}(${defaults}); }`);
            }
        }
    }

    // Async method (full params)
    if (!m.isWatch) {
        lines.push(`    public CompletableFuture<${m.javaReturnType}> ${methodName}Async(${fullParamDecl}) {`);
        lines.push(`        return ${delegateCall}.thenApply(${genAsyncReturnExpr(m)});`);
        lines.push(`    }`);
    }

    return lines.join('\n');
}

function categorize(name: string): string {
    if (/^fetch(Ticker|OrderBook|Trade|OHLCV|Market|Currenc|BidsAsks|MarkPrice|L2|Time)/.test(name)) return 'Market Data';
    if (/^(create|edit|cancel|fetchOrder|fetchOpen.*Order|fetchClosed|fetchCanceled|fetchMyTrade|fetchMyLiquid|fetchOrderTrade)/.test(name)) return 'Trading';
    if (/^(fetchBalance|fetchAccount|loadAccount)/.test(name)) return 'Account';
    if (/^(withdraw|transfer|fetchDeposit|fetchWithdraw|createDeposit|fetchTransaction)/.test(name)) return 'Funding';
    if (/^(fetchPosition|fetchFunding|fetchOpenInterest|fetchLeverage|setLeverage|setMargin|setPosition|fetchLong|fetchMarginAdj|fetchMarginMode|closePosition|closeAllPosition)/.test(name)) return 'Derivatives';
    if (/^fetchTrading(Fee)/.test(name)) return 'Fees';
    if (/^fetchLedger/.test(name)) return 'Ledger';
    if (/^(fetchBorrow|fetchCrossBorrow|fetchIsolatedBorrow)/.test(name)) return 'Borrow';
    if (/^watch/.test(name)) return 'WebSocket';
    return 'Other';
}

function generateTypedMethodsBlock(methods: MethodInfo[]): string {
    const cats: Record<string, MethodInfo[]> = {};
    for (const m of methods) {
        const cat = categorize(m.name);
        (cats[cat] = cats[cat] || []).push(m);
    }

    const sections: string[] = [];

    // Add the toTypedList helper
    sections.push(`    @SuppressWarnings("unchecked")`);
    sections.push(`    protected static <T> List<T> toTypedList(Object raw, java.util.function.Function<Object, T> ctor) {`);
    sections.push(`        return ((List<Object>) raw).stream().map(ctor).collect(java.util.stream.Collectors.toList());`);
    sections.push(`    }`);
    sections.push('');

    // Special: loadMarkets typed overloads
    sections.push(`    // --- loadMarkets (special: first arg is boolean reload) ---`);
    sections.push(`    @SuppressWarnings("unchecked")`);
    sections.push(`    public Map<String, io.github.ccxt.types.MarketInterface> loadMarkets(boolean reload) {`);
    sections.push(`        Object res = this.loadMarkets((Object) reload).join();`);
    sections.push(`        java.util.LinkedHashMap<String, io.github.ccxt.types.MarketInterface> result = new java.util.LinkedHashMap<>();`);
    sections.push(`        for (Map.Entry<String, Object> entry : ((Map<String, Object>) res).entrySet()) {`);
    sections.push(`            result.put(entry.getKey(), new io.github.ccxt.types.MarketInterface(entry.getValue()));`);
    sections.push(`        }`);
    sections.push(`        return result;`);
    sections.push(`    }`);
    sections.push(`    @SuppressWarnings("unchecked")`);
    sections.push(`    public CompletableFuture<Map<String, io.github.ccxt.types.MarketInterface>> loadMarketsAsync(boolean reload) {`);
    sections.push(`        return this.loadMarkets((Object) reload).thenApply(res -> {`);
    sections.push(`            java.util.LinkedHashMap<String, io.github.ccxt.types.MarketInterface> result = new java.util.LinkedHashMap<>();`);
    sections.push(`            for (Map.Entry<String, Object> entry : ((Map<String, Object>) res).entrySet()) {`);
    sections.push(`                result.put(entry.getKey(), new io.github.ccxt.types.MarketInterface(entry.getValue()));`);
    sections.push(`            }`);
    sections.push(`            return result;`);
    sections.push(`        });`);
    sections.push(`    }`);
    sections.push('');

    for (const [cat, ms] of Object.entries(cats)) {
        sections.push(`    // ==========================================`);
        sections.push(`    // ${cat}`);
        sections.push(`    // ==========================================\n`);
        for (const m of ms) {
            sections.push(`    @SuppressWarnings("unchecked")`);
            sections.push(genMethod(m));
            sections.push('');
        }
    }

    return sections.join('\n');
}

function injectIntoExchangeJava(typedMethodsBlock: string) {
    let content = fs.readFileSync(EXCHANGE_JAVA_FILE, 'utf-8');

    // Check if markers already exist (from a previous run)
    const startIdx = content.indexOf(TYPED_METHODS_MARKER);
    const endIdx = content.indexOf(TYPED_METHODS_END_MARKER);

    if (startIdx !== -1 && endIdx !== -1) {
        // Replace existing typed methods block
        const beforeMarker = content.substring(0, startIdx);
        const afterEndMarker = content.substring(endIdx + TYPED_METHODS_END_MARKER.length);
        content = beforeMarker + TYPED_METHODS_MARKER + '\n\n' + typedMethodsBlock + '\n\n' + TYPED_METHODS_END_MARKER + afterEndMarker;
    } else {
        // First time: inject before the closing } of the class
        const lastBrace = content.lastIndexOf('}');
        if (lastBrace === -1) {
            throw new Error('Could not find closing } in Exchange.java');
        }
        const before = content.substring(0, lastBrace);
        const after = content.substring(lastBrace);
        content = before + '\n    ' + TYPED_METHODS_MARKER + '\n\n' + typedMethodsBlock + '\n\n    ' + TYPED_METHODS_END_MARKER + '\n' + after;
    }

    // Ensure types import is present
    if (!content.includes('import io.github.ccxt.types.*;')) {
        // Add after the last existing import
        const lastImportIdx = content.lastIndexOf('\nimport ');
        if (lastImportIdx !== -1) {
            const endOfImportLine = content.indexOf('\n', lastImportIdx + 1);
            content = content.substring(0, endOfImportLine + 1) + 'import io.github.ccxt.types.*;\n' + content.substring(endOfImportLine + 1);
        }
    }

    fs.writeFileSync(EXCHANGE_JAVA_FILE, content, 'utf-8');
}

// --- Main ---
console.log('Parsing TypeScript Exchange.ts...');
const methods = parseMethodsFromTS();
const restCount = methods.filter(m => !m.isWatch).length;
const wsCount = methods.filter(m => m.isWatch).length;
console.log(`Found ${methods.length} methods (REST: ${restCount}, WS: ${wsCount})`);

// Show a few examples with params
for (const m of methods.slice(0, 5)) {
    const allParams = [...m.requiredParams, ...m.optionalParams];
    console.log(`  ${m.name}(${allParams.map(p => `${p.javaType} ${p.name}${p.isOptional ? '?' : ''}`).join(', ')}) -> ${m.javaReturnType}`);
}

const typedBlock = generateTypedMethodsBlock(methods);
console.log(`\nGenerated ${typedBlock.split('\n').length} lines of typed methods`);

console.log(`\nInjecting into ${EXCHANGE_JAVA_FILE}...`);
injectIntoExchangeJava(typedBlock);

// Export the method list for the Java transpiler to use as its cast target set.
// The transpiler reads this JSON to know which methods need (Object) casts on args.
// Also include loadMarkets which has a special typed overload.
const typedMethodNames = ['loadMarkets', ...methods.map(m => camelCase(m.name))];
fs.writeFileSync(TYPED_METHODS_JSON, JSON.stringify(typedMethodNames, null, 2), 'utf-8');
console.log(`Exported ${typedMethodNames.length} method names to ${TYPED_METHODS_JSON}`);

console.log('Done!');
