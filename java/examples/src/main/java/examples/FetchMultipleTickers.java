package examples;

import io.github.ccxt.Exchange;
import io.github.ccxt.ExchangeTyped;
import io.github.ccxt.types.Ticker;
import io.github.ccxt.types.Tickers;

import java.util.List;
import java.util.Map;

/**
 * Fetch multiple tickers and display a price comparison table.
 *
 * Usage:
 *   cd java && ./gradlew :examples:run -PmainClass=examples.FetchMultipleTickers
 */
public class FetchMultipleTickers {

    public static void main(String[] args) {
        String exchangeId = args.length > 0 ? args[0] : "binance";

        System.out.println("Exchange: " + exchangeId);
        System.out.println();

        Exchange raw = Exchange.dynamicallyCreateInstance(exchangeId, null);
        ExchangeTyped exchange = new ExchangeTyped(raw);

        exchange.loadMarkets();

        List<String> symbols = List.of(
                "BTC/USDT", "ETH/USDT", "SOL/USDT", "XRP/USDT", "DOGE/USDT"
        );

        Tickers tickers = exchange.fetchTickers(symbols, null);

        System.out.printf("%-12s %12s %12s %12s %10s %12s%n",
                "Symbol", "Last", "Bid", "Ask", "Change%", "Volume");
        System.out.println("-".repeat(72));

        for (String symbol : symbols) {
            Ticker t = tickers.get(symbol);
            if (t != null) {
                System.out.printf("%-12s %12.4f %12.4f %12.4f %9.2f%% %12.2f%n",
                        t.symbol,
                        safe(t.last),
                        safe(t.bid),
                        safe(t.ask),
                        safe(t.percentage),
                        safe(t.baseVolume));
            }
        }
    }

    static double safe(Double v) { return v != null ? v : 0.0; }
}
