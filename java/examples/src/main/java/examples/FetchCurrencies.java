package examples;

import io.github.ccxt.Exchange;
import io.github.ccxt.types.Currencies;
import io.github.ccxt.types.CurrencyInterface;

import java.util.Map;

/**
 * Fetch and display available currencies from an exchange.
 *
 * Note: some exchanges (e.g. Binance) require API keys for fetchCurrencies.
 *
 * Usage:
 *   cd java && ./gradlew :examples:run -PmainClass=examples.FetchCurrencies
 *   cd java && ./gradlew :examples:run -PmainClass=examples.FetchCurrencies --args="kraken"
 */
public class FetchCurrencies {

    public static void main(String[] args) {
        String exchangeId = args.length > 0 ? args[0] : "kraken";

        System.out.println("Exchange: " + exchangeId);
        System.out.println();

        Exchange exchange = Exchange.dynamicallyCreateInstance(exchangeId, null);

        exchange.loadMarkets(false);

        Currencies currencies = exchange.fetchCurrencies((Map<String, Object>) null);

        if (currencies.currencies.isEmpty()) {
            System.out.println("No currencies returned (this exchange may require API keys for fetchCurrencies).");
            return;
        }

        // Show some popular currencies
        String[] popular = {"BTC", "ETH", "USDT", "SOL", "XRP", "DOGE", "ADA", "AVAX"};

        System.out.printf("%-8s %-20s %-8s %-10s%n", "Code", "Name", "Active", "Fee");
        System.out.println("-".repeat(50));

        for (String code : popular) {
            CurrencyInterface c = currencies.currencies.get(code);
            if (c != null) {
                System.out.printf("%-8s %-20s %-8s %-10s%n",
                        c.code,
                        c.name != null ? (c.name.length() > 18 ? c.name.substring(0, 18) + ".." : c.name) : "n/a",
                        c.active,
                        c.fee != null ? c.fee : "n/a");
            }
        }

        System.out.println("\nTotal currencies: " + currencies.currencies.size());
    }
}
