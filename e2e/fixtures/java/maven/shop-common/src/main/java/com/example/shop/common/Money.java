package com.example.shop.common;

import java.math.BigDecimal;
import java.util.Objects;

/** An amount in one currency. */
public record Money(BigDecimal amount, String currency) {
  public Money {
    Objects.requireNonNull(amount, "amount");
    Objects.requireNonNull(currency, "currency");
  }

  public static Money of(String amount, String currency) {
    return new Money(new BigDecimal(amount), currency);
  }

  public Money plus(Money other) {
    if (!currency.equals(other.currency())) {
      throw new IllegalArgumentException("currency mismatch");
    }
    return new Money(amount.add(other.amount()), currency);
  }
}
