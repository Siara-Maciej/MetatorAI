package com.example.shop.domain;

import jakarta.persistence.Column;
import jakarta.persistence.Embedded;
import jakarta.persistence.Entity;
import jakarta.persistence.OneToMany;
import jakarta.persistence.Table;
import java.util.ArrayList;
import java.util.List;

@Entity
@Table(name = "customers")
public class Customer extends BaseEntity {
  @Column(nullable = false, length = 80)
  private String name;

  @Column(unique = true)
  private String email;

  @Embedded
  private Address address;

  @OneToMany(mappedBy = "customer")
  private List<Order> orders = new ArrayList<>();

  public String getName() {
    return name;
  }

  public String getEmail() {
    return email;
  }
}
