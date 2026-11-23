package com.example.shop.domain;

import jakarta.persistence.Column;
import jakarta.persistence.Embeddable;

@Embeddable
public class Address {
  @Column(name = "street_line", length = 120)
  private String street;

  private String city;

  @Column(name = "postal_code", length = 10, nullable = false)
  private String postalCode;
}
