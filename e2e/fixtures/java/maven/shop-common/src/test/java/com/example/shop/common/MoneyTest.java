package com.example.shop.common;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

class MoneyTest {
  @Test
  void addsAmountsOfOneCurrency() {
    assertEquals(Money.of("3.50", "EUR"), Money.of("1.25", "EUR").plus(Money.of("2.25", "EUR")));
  }

  @Test
  void squareAreaFromTheSealedHierarchy() {
    assertEquals(9.0, Shape.area(new Shape.Square(3)));
  }
}
