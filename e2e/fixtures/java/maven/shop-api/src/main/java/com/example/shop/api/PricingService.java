package com.example.shop.api;

import java.math.BigDecimal;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

@Service
public class PricingService {
  @Value("${shop.currency:EUR}")
  private String currency;

  @Value("${shop.tax-rate}")
  private BigDecimal taxRate;

  public String format(BigDecimal amount) {
    return amount == null ? "0 " + currency : amount.add(amount.multiply(taxRate)) + " " + currency;
  }
}
