package com.example.inventory.app;

import com.example.inventory.core.Stock;

public class InventoryApp {
  public static void main(String[] args) {
    Stock stock = new Stock();
    stock.receive("A-1", 1);
    System.out.println(stock.level("A-1"));
  }
}
