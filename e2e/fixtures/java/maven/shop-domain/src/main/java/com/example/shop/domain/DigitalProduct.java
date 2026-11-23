package com.example.shop.domain;

import jakarta.persistence.Entity;

@Entity
public class DigitalProduct extends Product {
  private String downloadUrl;
}
