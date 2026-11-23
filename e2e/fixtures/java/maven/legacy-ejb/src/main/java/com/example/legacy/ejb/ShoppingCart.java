package com.example.legacy.ejb;

import jakarta.ejb.Stateful;
import java.util.ArrayList;
import java.util.List;

@Stateful
public class ShoppingCart {
  private final List<String> items = new ArrayList<>();

  public void add(String sku) {
    items.add(sku);
  }
}
