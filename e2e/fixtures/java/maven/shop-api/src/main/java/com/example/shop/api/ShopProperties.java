package com.example.shop.api;

import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties(prefix = "shop.orders")
public class ShopProperties {
  private int maxLines = 50;
  private boolean allowGuests;

  public int getMaxLines() {
    return maxLines;
  }

  public void setMaxLines(int maxLines) {
    this.maxLines = maxLines;
  }

  public boolean isAllowGuests() {
    return allowGuests;
  }

  public void setAllowGuests(boolean allowGuests) {
    this.allowGuests = allowGuests;
  }
}
