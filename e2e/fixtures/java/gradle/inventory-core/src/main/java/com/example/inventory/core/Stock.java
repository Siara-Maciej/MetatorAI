package com.example.inventory.core;

import java.util.HashMap;
import java.util.Map;

public class Stock {
  private final Map<String, Integer> levels = new HashMap<>();

  public void receive(String sku, int quantity) {
    levels.merge(sku, quantity, Integer::sum);
  }

  public int level(String sku) {
    return levels.getOrDefault(sku, 0);
  }
}
