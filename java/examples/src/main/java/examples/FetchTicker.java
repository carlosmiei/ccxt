package examples;

import io.github.ccxt.Exchange;
import io.github.ccxt.types.Ticker;

/**
 * Fetch a single ticker from an exchange.
 *
 * Usage:
 *   cd java && ./gradlew :examples:run -PmainClass=examples.FetchTicker
 *   cd java && ./gradlew :examples:run -PmainClass=examples.FetchTicker --args="bybit ETH/USDT"
 */
public class FetchTicker {

    public static void main(String[] args) {
        String exchangeId = args.length > 0 ? args[0] : "binance";
        String symbol = args.length > 1 ? args[1] : "BTC/USDT";

        System.out.println("Exchange: " + exchangeId);
        System.out.println("Symbol:   " + symbol);
        System.out.println();

        Exchange exchange = Exchange.dynamicallyCreateInstance(exchangeId, null);

        exchange.loadMarkets(false);

        Ticker ticker = exchange.fetchTicker(symbol);

        System.out.println(symbol + " Ticker");
        System.out.println("  Last:       " + ticker.last);
        System.out.println("  Bid:        " + ticker.bid);
        System.out.println("  Ask:        " + ticker.ask);
        System.out.println("  High:       " + ticker.high);
        System.out.println("  Low:        " + ticker.low);
        System.out.println("  Open:       " + ticker.open);
        System.out.println("  Close:      " + ticker.close);
        System.out.println("  Volume:     " + ticker.baseVolume);
        System.out.println("  Change:     " + ticker.change);
        System.out.println("  Change %:   " + ticker.percentage);
        System.out.println("  Timestamp:  " + ticker.timestamp);
        System.out.println("  Datetime:   " + ticker.datetime);
    }
}
