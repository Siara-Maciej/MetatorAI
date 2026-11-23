package com.example.shop.domain.service;

import com.example.shop.common.Money;
import com.example.shop.domain.Order;
import com.example.shop.domain.OrderStatus;
import com.example.shop.domain.repo.CustomerRepository;
import com.example.shop.domain.repo.OrderRepository;
import java.util.List;
import java.util.Optional;
import org.springframework.stereotype.Service;

@Service
public class OrderService {
  private final OrderRepository orders;
  private final CustomerRepository customers;

  public OrderService(OrderRepository orders, CustomerRepository customers) {
    this.orders = orders;
    this.customers = customers;
  }

  public Optional<Order> find(Long id) {
    return orders.findById(id);
  }

  public List<Order> byStatus(OrderStatus status) {
    return orders.findByStatus(status);
  }

  public Money zero(String currency) {
    return Money.of("0", currency);
  }
}
