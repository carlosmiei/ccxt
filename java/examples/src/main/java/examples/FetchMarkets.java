package examples;

import io.github.ccxt.Exchange;
import io.github.ccxt.ExchangeTyped;
import io.github.ccxt.types.MarketInterface;

import java.util.List;
import java.util.Map;

/**
 * Fetch and display available markets from an exchange.
 *
 * Usage:
 *   cd java && ./gradlew :examples:run -PmainClass=examples.FetchMarkets
 *   cd java && ./gradlew :examples:run -PmainClass=examples.FetchMarkets --args="bybit spot"
 */
public class FetchMarkets {

    public static void main(String[] args) {
        String exchangeId = args.length > 0 ? args[0] : "binance";
        String filterType = args.length > 1 ? args[1] : null; // "spot", "swap", "future", "option"

        System.out.println("Exchange: " + exchangeId);
        if (filterType != null) System.out.println("Filter:   " + filterType);
        System.out.println();

        Exchange raw = Exchange.dynamicallyCreateInstance(exchangeId, null);
        ExchangeTyped exchange = new ExchangeTyped(raw);

        Map<String, MarketInterface> markets = exchange.loadMarkets();

        System.out.printf("%-16s %-8s %-6s %-8s %-12s %-14s %-14s%n",
                "Symbol", "Type", "Active", "Base", "Quote", "Price Prec", "Amount Prec");
        System.out.println("-".repeat(82));

        int count = 0;
        for (MarketInterface m : markets.values()) {
            // Apply type filter if specified
            if (filterType != null && !filterType.equals(m.type)) continue;

            // Show first 30 markets to keep output manageable
            if (++count > 30) {
                System.out.println("... (showing first 30 of " + markets.size() + " markets)");
                break;
            }

            System.out.printf("%-16s %-8s %-6s %-8s %-12s %-14s %-14s%n",
                    m.symbol,
                    m.type,
                    m.active,
                    m.base,
                    m.quote,
                    m.precision != null ? m.precision.price : "n/a",
                    m.precision != null ? m.precision.amount : "n/a");
        }

        System.out.println("\nTotal markets loaded: " + markets.size());
    }
}
