import ccxt from '../../ts/ccxt.js';

// AUTO-TRANSPILE //

async function example () {
    const exchange = new ccxt.polymarket ();
    const kalshi = new ccxt.kalshi ();
    const limitless = new ccxt.limitless ();
    const [ polyEvents, kalshiEvents, limitlessEvents ] = await Promise.all ([
        exchange.fetchEvents ([ 'Trump' ]),
        kalshi.fetchEvents ([ 'Trump' ]),
        limitless.fetchEvents ([ 'Trump' ]),
    ]);


    const first = polyEvents[0];
    const second = kalshiEvents[0];
    const third = limitlessEvents[0];


    //     console.log (first);
    //     console.log (second);
    //     console.log (third);


    const firstOutcome = first.markets[0].outcomes[0].id;
    const secondOutcome = second.markets[0].outcomes[0].id;
    const thirdOutcome = third.markets[0].outcomes[0].id;

    console.log (firstOutcome, secondOutcome, thirdOutcome);


    const [ firstOHLCV, secondOHLCV, thirdOHLCV ] = await Promise.all ([
        exchange.fetchTrades (firstOutcome),
        kalshi.fetchTrades (secondOutcome),
        limitless.fetchTrades (thirdOutcome),
    ]);
    console.log (firstOHLCV, secondOHLCV, thirdOHLCV);
}
await example ();
