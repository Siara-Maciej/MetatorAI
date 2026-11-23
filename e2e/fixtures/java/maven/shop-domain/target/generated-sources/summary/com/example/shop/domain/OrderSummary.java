package com.example.shop.domain;

import javax.annotation.processing.Generated;

/** Written by an annotation processor at build time; committed here as a generated source. */
@Generated("com.example.processor.SummaryProcessor")
public final class OrderSummary {
  private final Long orderId;
  private final OrderStatus status;

  public OrderSummary(Long orderId, OrderStatus status) {
    this.orderId = orderId;
    this.status = status;
  }

  public Long orderId() {
    return orderId;
  }

  public OrderStatus status() {
    return status;
  }
}
