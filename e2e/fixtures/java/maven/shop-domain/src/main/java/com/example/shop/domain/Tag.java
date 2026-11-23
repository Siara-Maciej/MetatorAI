package com.example.shop.domain;

import jakarta.persistence.Entity;
import jakarta.persistence.Id;

@Entity
public class Tag {
  @Id
  private String label;
}
