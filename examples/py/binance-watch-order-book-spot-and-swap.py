import ccxt.pro
from importlib import import_module
from importlib.util import find_spec

run = import_module(next(filter(find_spec, ('uvloop', 'winloop', 'asyncio')))).run


# watch the order books of a spot market and a swap market with the same
# exchange-specific id (BTC/USDT and BTC/USDT:USDT are both BTCUSDT on
# binance) at the same time — each stream runs on its own connection and
# the updates must keep flowing for both symbols independently


async def watch_symbol(exchange, symbol):
    while True:
        try:
            orderbook = await exchange.watch_order_book(symbol)
            print(symbol, orderbook['nonce'], 'bid:', orderbook['bids'][0], 'ask:', orderbook['asks'][0])
        except Exception as e:
            print(type(e).__name__, str(e))
            break


async def main():
    exchange = ccxt.pro.binance()
    spot = 'BTC/USDT'
    swap = 'BTC/USDT:USDT'
    try:
        await import_module('asyncio').gather(
            watch_symbol(exchange, spot),
            watch_symbol(exchange, swap),
        )
    finally:
        await exchange.close()


run(main())
