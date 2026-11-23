package com.example.legacy.model;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

@Entity
@Table(name = "invoice")
public class Invoice {
  @Id
  private long id;

  @Column(name = "customer_ref", nullable = false)
  private String customer;

  public long getId() {
    return id;
  }

  public String getCustomer() {
    return customer;
  }
}
