package com.example.inventory.core;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

class StockTest {
  @Test
  void receivedQuantitiesAddUp() {
    Stock stock = new Stock();
    stock.receive("A-1", 2);
    stock.receive("A-1", 3);
    assertEquals(5, stock.level("A-1"));
  }
}
