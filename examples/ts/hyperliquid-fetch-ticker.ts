import ccxt from '../../ts/ccxt.js';

async function example () {
    const exchange = new ccxt.hyperliquid ({
        'sandboxMode': true,  // outcome markets are on testnet
    });

    const polyEvents = await exchange.fetchEvents ([ 'BTC' ]);

    const first = polyEvents[0];

    const firstOutcome = first.markets[0].outcomes[0].id;

    console.log (firstOutcome);

    const firstTicker = await exchange.fetchTicker (firstOutcome);
    console.log (firstTicker);
}
await example ();
