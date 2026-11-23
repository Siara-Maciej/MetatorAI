package com.example.shop.domain;

import jakarta.persistence.Entity;
import jakarta.persistence.ManyToOne;

@Entity
public class OrderLine extends BaseEntity {
  @ManyToOne
  private Order order;

  @ManyToOne
  private Product product;

  private int quantity;
}
